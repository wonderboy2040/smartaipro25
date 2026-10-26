// ============================================================
// server/ai/routes.js — AI TRADING TERMINAL endpoints
// ------------------------------------------------------------
//   GET  /api/ai/status                  models + risk + connections
//   GET  /api/ai/signals?market=&limit=  ensemble signal board
//   GET  /api/ai/deep/:symbol?market=    one symbol, every model vote
//   GET  /api/ai/options?symbol=NIFTY    chain + analytics + strategies
//   GET  /api/ai/trading/state           config + daily risk state
//   POST /api/ai/trading/config          update (LIVE needs typed phrase)
//   POST /api/ai/trading/kill-switch     { enabled }
//   POST /api/ai/execute                 THE gauntlet — crypto (paper | live)
//   POST /api/ai/india/execute           THE gauntlet — India Dhan (v6.5)
//   GET  /api/ai/positions               journal positions + uPnL + entries
//   GET  /api/ai/positions/stream        SSE: realtime LTP/PnL diff-push (v10.5.3)
//   POST /api/ai/positions/close         { id } (routes by market)
//   GET  /api/ai/orders                  CoinDCX exchange open orders
//   POST /api/ai/orders/cancel           { id }
//   POST /api/ai/orders/cancel-all       emergency flatten
//   GET  /api/ai/backtest?market=        v6.5 walk-forward ensemble replay
//   GET  /api/ai/alerts/config           v6.5 masked telegram + AI key status
//   POST /api/ai/alerts/config           v6.5 save secrets (masked read-back)
//   POST /api/ai/alerts/test             v6.5 send a test telegram message
//   POST /api/ai/dhan/connect            v6.5 { clientId, accessToken }
//   POST /api/ai/dhan/disconnect         v6.5
//   GET  /api/ai/dhan/status             v6.5 connected + scrip master + profile
//
// Background loops (unref'd, non-fatal):
//   • position watcher (60s)   — crypto SL/TP + trailing
//   • India watcher (60s)      — India SL/TP + trailing + 15:15 square-off
//   • STRONG-signal alerter (60s) — telegram on fresh STRONG consensus
//   • auto-executor  (90s)     — STRONG-only auto trading when enabled
// ============================================================
import { getSignals, getDeepSignal, getFreshSignalForExec, getFreshFuturesSignalForExec, getFreshGlobalSignalForExec, buildRegime } from './signals.js';
// v18.5 FIX: wire the live signal board's symbols into the intraday SSE
// watcher — before this, the board cards' LIVE LTP badge was dead unless a
// symbol happened to be a paper position (setScanSymbols existed but was
// only ever called by /api/intraday-scanner, which no frontend polls).
import { setScanSymbols as intradaySetScanSymbols, getLatestQuotes } from '../intraday/stream.js';
import { getDirectionReport } from '../intraday/trackRecord.js';
import { openPaperTrade as openPaperTradeExec, closePaperTrade as closePaperTradeExec, voidPaperTrade as voidPaperTradeExec, getPaperSummary as getPaperSummaryExec, updatePaperTradeStopLoss, updatePaperTradeT1ClosePct, updatePaperTradeTarget2, bookPaperT1Partial as bookPaperT1PartialExec, evaluatePaper } from '../intraday/paperTrading.js';
// v20.2 ACCOUNTABILITY: the board's ACTIONABLE signals (STRONG + ACTION
// with a plan) feed the signal Track Record — the panel's "har published
// signal track hota hai" promise is finally true for the board the user
// actually sees (INDIA + CRYPTO desks; FUTURES/GLOBALFUTURES plans are
// USDT/USDC-denominated vs the watcher's INR quotes — skipped explicitly).
import { wireBoardAccountability } from './boardAccountability.js';
// v20.2: USDINR last-known-good fallback (disk-backed) — flat-84 sirf
// tab jab process ne kabhi live rate nahi dekha.
import { usdInrFallback } from './lib/usdinr.js';
// v20.2: candle data for the signal-card / deep-modal price charts.
import { chartCandles } from './mtf.js';
// v21.15.0 MTF TRADE PLAN ENGINE (user spec: 15m→5m intraday / 1h→15m swing
// top-down plan + honest TF-fit verdict + cost-in-R reality check)
import { getTradePlan, planModeList } from './tradePlanner.js';
// v20.2: intraday gate replay harness.
import { replayIntradayGates } from './replay.js';
// v2 signal-accuracy upgrade (sentiment / instflow / fundamentals desks)
import { v2ModelsEnabled } from './models.js';
import { sentimentStatus } from './sentiment.js';
// v18.4 EXPERT MODE — local AI (Chronos + FinBERT) orchestrator
import { expertAnalyze, expertStatus, expertDownloadModels, expertWarmModels } from './expertMode.js';
import { instFlowStatus } from './instFlow.js';
import { fundamentalsStatus } from './fundamentals.js';
// v11.6 MESH-BACKED SEATS — status + accountability views (the mesh
// finally votes; Phase 4 makes it VISIBLE).
import { meshModelsStatusView, meshModelAccountability, meshCorrelationView } from './meshModels.js';
// v10.1 crypto desk AI chatbot (mirror of the intraday ProTrader agent)
import { runCryptoAgent } from './cryptoAgent.js';
import { getExpertPicks } from './expertPicks.js';
// v12.0 PRO TRADER UPGRADE — perp positioning intelligence endpoint
// (funding / open-interest / top-trader L-S / taker flow reads).
import { perpIntelBoardView, perpIntelEnabled } from './perpIntel.js';
import { getOptionsDesk, buildStrategies, getOptionSignalsView } from './optionsDesk.js';
import {
  loadConfig, updateConfig, getRiskState, executeSignal, getPositionsWithPnl,
  closePosition, listExchangeOrders, cancelExchangeOrder, cancelAllExchangeOrders,
  watchPositions, loadJournal, dailyStats, clearClosedPositions,
  // v20.7.12 [/api/exec/enter]: journal discipline (lock + audit entry)
  withJournalLock, pushEntry, todayIST, saveJournal,
} from './coindcxOrders.js';
import {
  executeFuturesSignal, executeMtfDualLiveOrder, loadCredsForOrder,
  watchFuturesPositions, closeFuturesPosition,
  walletSnapshot, futuresMarketsView, fetchUsdInr, fetchFuturesPrices,
  syncCoinDcxActivePositionsForControl, updateCoinDcxPositionSl, closeCoinDcxActivePosition,
} from './futures.js';
// v12.8 SUPERINTELLIGENCE REVERSAL RECOVERY — ₹ loss-cap → flip →
// booking cycles (config echo + live cycle board for the UI).
import { loadReversalConfig, reversalCyclesView } from './reversalEngine.js';
// accuracy-plan Phase 4: the PORTFOLIO AI OVERLAY — red-flag engine
// (concentration × MacroRegime × top-holding ensemble views) + the
// quant-computes/LLM-narrates portfolio coach.
import { portfolioRedFlags, narratePortfolio } from './portfolioNarrative.js';
// v12.9: manual trades are ENGINE-CONNECTED — their ₹ cycles ride the
// same board (manualReversalCycles groups trades by t.reversal.cycleId).
import { manualReversalCycles } from './manualTrades.js';
import {
  executeGlobalSignal, watchGlobalPositions, closeGlobalPosition,
  globalFuturesMarketsView, fetchGlobalQuotes, fetchGlobalLtpMap,
} from './globalFutures.js';
// v10.5.3 REALTIME POSITIONS — SSE diff-push of open-position LTP/PnL
// (replaces the 5s REST poll the console used to call "ULTRA STREAM").
import { positionsStreamHandler } from './positionsStream.js';
import {
  agentTick, agentStatus, agentStart, agentStop, updateAgentConfig, loadAgentConfig, AGENT_TICK_SEC,
} from './agent.js';
// v18.6 SUPERINTELLIGENCE ADVANCE AI PRO TRADER AUTO (SAPTA) — the
// browser-automation auto-trade engine (AI 75+ / conf 65+ / verified 90+
// gates, CoinDCX + Dhan in the user's open browser, reversal-confirmed exits).
import {
  proTraderTick, proTraderStatusView, proTraderStart, proTraderStop,
  updateProTraderConfig, loadProTraderConfig as _loadProTraderConfig, proTraderStreamHandler,
  proTraderBrowserTest, proTraderTestRun, PROTRADER_TICK_SEC,
} from './proTraderAuto.js';
import { executeIndiaSignal, watchIndiaPositions, closeIndiaPosition } from './indiaOrders.js';
// v10.3: NSE SUPERINTELLIGENCE AUTO-AGENT — the India twin of agent.js
import {
  indiaAgentTick, indiaAgentStatus, indiaAgentStart, indiaAgentStop,
  updateIndiaAgentConfig, INDIA_AGENT_TICK_SEC,
} from './indiaAgent.js';
// v21.0.2 OPTIONS AUTO-ENTRY — NIFTY/SENSEX option cards ka paper
// auto-entry loop (tradeable cards → openPaperTrade; exit watcher
// intraday/stream.js me pehle se hai). Default OFF — UI/API se toggle.
import {
  optionsAutoTick, optionsAutoStatus, setOptionsAutoEnabled,
} from './optionsAutoEntry.js';
import { runBacktest } from './backtest.js';
// v10.8 PRO #2: NL Custom Strategy Lab — description → bounded rules → replay
import { runCustomStrategyBacktest } from './strategyLab.js';
// v21.3.0 (Issue-1): constrained-platform warm-up gate (Render dyno etc.)
import { isConstrainedPlatform } from './selfHeal.js';
// v10.9 INSTANT TELEGRAM PUSH — the price-driven sink (SL/TP touches +
// STRONG signals) + the shared dedupe the 60s backup alerter reuses.
import {
  startInstaPushSink, scanStrongSignalsBackup, instaPushStatus, instantPushEnabled as _instantPushEnabled,
} from './telegramPush.js';
// v10.9 WEEKLY REVIEW — journal + calibration → one LLM narration
import { runWeeklyPerformanceReview, weeklyReviewStatus, scheduleWeeklyReviewPush } from './weeklyReview.js';
// v19.0 SELF-IMPROVEMENT ENGINE (Phases 1-5) — the closed loop:
// v20.6.3: SELF-IMPROVEMENT ENGINE — COMPLETELY REMOVED (default off).
// The user asked to "completely remove" the loop. v20.6.0 disabled the
// intervals (default SELFIMPROVE_ENABLED=false). v20.6.3 removed the 14
// /api/ai/self/* route handlers + the panel .tsx file.
// v20.7.11 DEAD-CODE PURGE: the three modules that had ZERO remaining
// consumers (retrainBridge.js — ml-service training bridge, whose only
// importer selfStatus.js was also dead; strategyEvolution.js — evolution
// runner, only commented route; selfStatus.js — the /self status rollup)
// are now DELETED from the tree. The six modules that still have live
// wiring under the opt-in SELFIMPROVE_ENABLED=true flag in server/index.js
// (outcomeHarvester, driftMonitor, gateTuner, lessonsEngine, selfCouncil,
// evolutionLedger) remain — council.js also consumes lessonsEngine for
// the lessonsBlock prompt.
//
// To re-enable manually: set SELFIMPROVE_ENABLED=true in .env (the
// index.js opt-in block arms the loop intervals).
// Deleted modules are recoverable from git history (pre-v20.7.11).
// v10.16 SECTION 2: MANUAL TRADE TRACKER — user's own trades get the
// same live tracking + conviction intelligence the desk gives its own.
// v12.0: + R-multiple/MFE-MAE excursion tracking + aggregate stats.
import {
  recordManualTrade, listManualTrades, getManualTrade as _getManualTrade, closeManualTrade,
  ltpForManualTrade, manualTradeView, manualConvictionOf, lastKnownConvictionForView,
  startManualTradeMonitor, manualMonitorStatus, flushManualState as _flushManualState,
  updateExcursion, manualStats,
} from './manualTrades.js';
import { getTick as _getTick } from '../liveFeed.js';
// v20.7.5 THE 15s SIGNAL RECHECK LOOP — every STRONG/ACTION board
// signal re-validated against live prices every 15s (SL-through ·
// adverse drift · T1/T2 touch) + staggered committee re-votes, with
// Telegram pushes on flips/invalidations and a live panel view.
import {
  startSignalRecheckLoop, signalRecheckStatus, buildTickStoreResolver, recheckEnabled as _recheckEnabled,
} from './signalRecheck.js';
// v18.6.4: 30s TV-batch micro-cache for the tracker's India fallback —
// the 5s poll no longer fires an uncached TV scanner POST per cycle.
const _tvIndiaBatchCache = new Map();
// v18.6.3 REALTIME NEVER STOPS: the manual-trade monitor's own upstream
// subscription hold (see startManualTradeMonitor wiring below) — the
// tick store keeps updating for OPEN trades with ZERO browser SSE
// clients (app tab hidden, reconnect blip, feed restart).
import {
  ensureCryptoSubscribed, releaseCryptoSubscribed, cryptoClientUp, cryptoClientDown, fetchCoinDcxTickers,
} from '../cryptoStream.js';
import { ensureInSubscribed, releaseInSubscribed, inClientUp, inClientDown } from '../inStream.js';
import { ensureCxRtSubscribed, releaseCxRtSubscribed, cxRtClientUp, cxRtClientDown } from './cxRtStream.js';
import { getSwingBoard, scanWhales, getOrderbook } from './swing.js';
import { readDepth, depthStatus } from './orderFlowDepth.js';
import { wickFilterStatus } from './wickFilter.js';
import { ledgerStatus, recentEntries, verifyLedger } from './ledger.js';
import { adaptiveStatus } from './adaptive.js';
import { regimeReweightView } from './ensemble.js';
import { trustReport, governance, modelPerformanceWindows, councilCalibration, mtfABReport } from './trust.js';
import { perfReport } from './perf.js';
import { correlationMatrix, pairCorrelation } from './correlation.js';
// v10.15 GAP 2: Event Guard — the board attaches the next scheduled
// event per signal (the signal-card ⚠ chip a manual trader sees).
import { eventGuardStatus } from './eventGuard.js';
// v11.0 GLOBAL MARKET COUNCIL — status/deep-verdict/near-miss routes.
import { councilStatus, runCouncilDeep, councilStampOf } from './council.js';
// v18.7 ENGINE SENTINEL — per-engine health view + manual recheck.
import { engineSnapshot, engineClearCooldowns, ollamaProbe, ollamaStatus } from './llmSentinel.js';
import {
  opencodeProbe, opencodeStatus, opencodeClearCooldowns,
  probeOpenCodeSeats, OPENCODE_SEATS,
} from './opencodeBridge.js';
import { councilAskVision } from './llmChain.js';
import { coreSeatGuardStatus } from './seatCorrelation.js';
import { nearMissList, nearMissStats } from './consensus.js';
import { sectorDesk } from './sectors.js';
import { rankIncomeSetups } from './optionsDesk.js';
// v10.17 OPTIONS SCANNER — multi-underlying chain scan (indices + top
// F&O stocks), deterministic direction reads + GEX zones, one ranked view.
import { scanOptionsUniverse } from './optionsScan.js';
import {
  secretsStatus, setSecret, getSecrets, telegramConfig, sendTelegramMessage,
} from './secrets.js';
import { dhanConnect, dhanDisconnect, dhanConnected, dhanProfile, scripMasterStatus } from './dhan.js';
import { isNseOpen, fetchYahooQuotes, fetchTVIndiaBatch } from './data.js';
// v21.16.0 + v21.20.0 MTF SIGNALS BOARD (Dual-Timeframe) + AUTO-LINK engine
import { getDualMtfBoard, buildDualRow, dualAutoCandidates, mtfProEntryGate, peekDualMtfBoards, TOP_DEEP_TREND_LIMIT } from './mtfDualBoard.js';
import { mtfAutoTick, mtfAutoStatus, loadMtfAutoConfig, updateMtfAutoConfig, setMtfAutoEnabled, mtfAutoEnabled, MTF_AUTO_TICK_SEC, normalizeLinkSymbol, recordLiveMtfBoardTrade, recordPaperMtfBoardTrade, getActiveAutoTradesDeepMonitor, syncCoinDcxActivePositionsToDeepMonitor, isLiveAttemptBackoffActive, mtfAutoOpenCount, mtfAutoOpenRows, markAutoTradeTpSynced, markAutoTradeSlSynced, getAutoTradeSuperAgentOpenTrades } from './mtfAutoLink.js';
// v21.26.0 AI SUPER INTELLIGENCE — per-trade tick agent. Owns only routing /
// registry / stream holds; every trade decision is mtfAutoLink's
// mtfAutoSuperAgentManage (same gates as the 15s/60s sweeps).
import {
  startAutoTradeSuperAgent, refreshAutoTradeSuperAgent, autoTradeSuperAgentStatus,
} from './autoTradeSuperAgent.js';
// v21.25.0 DIRECTION CERTIFICATE — every manual board PAPER/LIVE order proves
// signal side → exchange order side before touching a broker.
import { buildDirectionCertificate, normalizeSide } from './directionCertificate.js';
import { buildPhase0Audit, getPhase0Summary } from './phase0Audit.js';
// v21.23.1: cross-engine direction-lock release-on-close sweeper (directionLock.js)
import { acquireDirectionLock, checkDirectionLock, reconcileDirectionLocks } from './directionLock.js';
// v21.23.4: runtime direction certificate (user demand: "accurately fix
// karo, concrete level pe" — rising→LONG/BUY · falling→SHORT/SELL proof)
import { runDirectionSelfTest } from './directionSelfTest.js';
// v13.2 B6: bandwidth telemetry view
import { bandwidthView } from './bandwidth.js';
// v13.2 A5: MCP tool-call audit view
import { mcpAuditView } from './mcpAudit.js';
// v13.2 A4: real portfolio risk analytics (Sharpe/Sortino/correlation/rebalance)
import { computePortfolioRiskAnalytics } from './riskAnalytics.js';
import { getAssetsSnapshot } from '../mcp/portfolioSync.js';

// ------------------------------------------------------------
// v20.7.5: the 15s recheck loop's LTP resolver — tick store FIRST
// (free, freshest when any SSE client/poller holds the symbol), then
// each market's own CACHED batch chain (CoinDCX tickers are WS-first
// upstream-cached · futures RT is 20s-cached · global quotes 5s-cached
// · India TV batch rides a 30s micro-cache so the 15s cadence never
// becomes a scanner hammer). Returns Map<symbol, {price, src}>.
// ------------------------------------------------------------
const _recheckTickHit = buildTickStoreResolver({ getTick: _getTick });
const _recheckIndiaCache = { at: 0, rows: null };
async function _recheckFetchLtp(market, symbols) {
  const out = new Map();
  const list = [...new Set((Array.isArray(symbols) ? symbols : []).map(s => String(s || '').toUpperCase()).filter(Boolean))];
  if (!list.length) return out;
  for (const s of list) {
    const hit = _recheckTickHit(market, s);
    if (hit) out.set(s, hit);
  }
  const missing = list.filter(s => !out.has(s));
  if (!missing.length) return out;
  try {
    if (market === 'CRYPTO') {
      // spot INR domain — matches the CRYPTO board's ₹ plans
      const tickers = await fetchCoinDcxTickers();
      for (const s of missing) {
        const t = (Array.isArray(tickers) ? tickers : []).find(x => x?.market === `${s}INR`);
        const px = t ? parseFloat(t.last_price) : NaN;
        if (px > 0) out.set(s, { price: px, src: 'coindcx-tickers' });
      }
    } else if (market === 'FUTURES') {
      const rows = await fetchFuturesPrices(); // 20s cache — free at 15s cadence
      for (const s of missing) {
        const r = (Array.isArray(rows) ? rows : []).find(x => x?.base === s);
        if (r?.last > 0) out.set(s, { price: r.last, src: r.source || 'futures-rt' });
      }
      // Also resolve XAU / XAG metals perps if any are still missing
      const stillMissing = missing.filter(s => !out.has(s) && (s === 'XAU' || s === 'XAG'));
      if (stillMissing.length > 0) {
        // v21.23.9: `./metals.js` repo me EXIST hi nahi karta tha — dono
        // import sites hamesha silently {fetchMetalsPrices: null} me
        // degrade hote the → XAU/XAG quote fallback legs (Binance fapi →
        // gold-api → Yahoo COMEX) 100% DEAD. Ab futures.js ka real
        // fetchMetalsPrices (same row shape) resolve hota hai.
        const { fetchMetalsPrices } = await import('./futures.js').catch(() => ({ fetchMetalsPrices: null }));
        if (typeof fetchMetalsPrices === 'function') {
          const mRows = await fetchMetalsPrices({ maxAgeMs: 15000 }).catch(() => null);
          for (const r of (Array.isArray(mRows) ? mRows : [])) {
            const base = String(r?.base || r?.symbol || '').replace(/^B-/, '').replace(/_USDT$/i, '').toUpperCase();
            const px = Number(r?.last ?? r?.price);
            if (base && px > 0 && !out.has(base)) out.set(base, { price: px, src: 'metals-perp' });
          }
        }
      }
    } else if (market === 'INDIA') {
      if (!_recheckIndiaCache.rows || Date.now() - _recheckIndiaCache.at > 30_000) {
        const rows = await fetchTVIndiaBatch(missing).catch(() => null);
        if (rows && Object.keys(rows).length) { _recheckIndiaCache.rows = rows; _recheckIndiaCache.at = Date.now(); }
      }
      const rows = _recheckIndiaCache.rows || {};
      for (const s of missing) {
        if (rows[s]?.ltp > 0) out.set(s, { price: rows[s].ltp, src: 'tv-india' });
      }
    } else if (market === 'GLOBALFUTURES') {
      const q = await fetchGlobalQuotes(); // 5s cache
      for (const s of missing) {
        const row = q?.get?.(s);
        if (row?.price > 0) out.set(s, { price: row.price, src: row.source || 'global-rt' });
      }
    }
  } catch { /* honest miss — the row stays PENDING and retries in 15s */ }
  return out;
}

// ------------------------------------------------------------
// v10.9 CONTROLLED TRADE APPROVAL — the Telegram webhook's SINGLE
// execution path. Wired at registration to the EXACT same
// executeSignal gauntlet POST /api/ai/execute runs (fresh-signal
// re-verification, kill switch, risk caps, mandate freeze). The
// approval button only ADDS a manual trigger — it bypasses none
// of the safety layers.
// ------------------------------------------------------------
let _approvedExec = null;
export async function runApprovedExecution(opts = {}) {
  if (!_approvedExec) throw new Error('AI trading routes not registered yet');
  return _approvedExec(opts);
}

// v20.7.8 [H2] legacy note: the 90s spot auto-executor's `_autoBusy`
// re-entrancy guard (fill journal me land hone se PEHLE next tick doosra
// order laga deta tha) v21.23.8 me hata diya gaya — wo loop ab PERMANENTLY
// disabled no-op shell hai (SPOT FULL STOP), koi gauntlet run nahi hota.

// v20.7.8 [M3]: the registrar arms ~12 live loops (watchers, agents, auto-
// executor, insta-push, recheck, monitors). A second registration (test
// harness, hot-reload, future second app) silently doubles EVERY loop —
// two auto-executors is double order placement. Guard it.
let _registered = false;

export function registerAITradingRoutes(app, deps) {
  if (_registered) {
    console.warn('[ai] registerAITradingRoutes called twice — live loops NOT re-armed (v20.7.8 guard)');
    return;
  }
  _registered = true;
  const { KEYS, OPENAI_COMPAT, TG, jsonError } = deps || {};
  // v21.24.0 AI TRIO PHASE 1: manual bridge probe throttle (1 / 10s).
  // The probe endpoint accepts only a seat name — never a model or prompt.
  let _trioProbeAt = 0;
  // v6.5: AI Council keys — secrets (typed in the app) WIN over env.
  // Built fresh on every call so a key saved mid-flight engages on the
  // next board run without a restart.
  const effectiveKeys = () => {
    try {
      const sec = getSecrets();
      return {
        ...(KEYS || {}),
        gemini: sec.geminiApiKey || (KEYS?.gemini || ''),
        groq: sec.groqApiKey || (KEYS?.groq || ''),
      };
    } catch { return KEYS || {}; }
  };

  const depsForSignals = () => ({
    KEYS: effectiveKeys(),
    OPENAI_COMPAT,
    getTradingConfig: () => { try { return loadConfig(); } catch { return {}; } },
  });

  // v21.25.3 [BOARD-SIGNAL COMPLETENESS]: the MTF board is not one signal
  // universe. The CRYPTO/FUTURES desk renders three domains — CoinDCX USDT
  // perps (FUTURES), GOLD/SILVER (METALS), and EQUITY SIM (GLOBALFUTURES).
  // Feeding the board only `getSignals('FUTURES')` left metals/equity rows
  // without their REAL main-AI ensemble signal → `ensembleSignalAvailable`
  // false → even ELITE rows were rejected ("main AI-BOARD ensemble signal
  // unavailable") and auto-trade never fired. One helper, every board site.
  const BOARD_SIGNAL_SCAN_MARKETS = {
    CRYPTO: ['FUTURES', 'METALS', 'GLOBALFUTURES'],
    FUTURES: ['FUTURES', 'METALS', 'GLOBALFUTURES'],
    METALS: ['METALS'],
    GLOBALFUTURES: ['GLOBALFUTURES'],
    EQUITY_SIM: ['GLOBALFUTURES'],
    INDIA: ['INDIA'],
  };
  const boardSignalKey = (sig, market) => normalizeLinkSymbol(
    String(sig?.symbol || '').toUpperCase().trim().replace(/^B-/, ''),
    market,
  );
  const boardSignalsForDesk = async (market, deps = depsForSignals()) => {
    const mkt = String(market || 'INDIA').toUpperCase();
    const scanMarkets = BOARD_SIGNAL_SCAN_MARKETS[mkt] || [mkt];
    const boards = await Promise.all(scanMarkets.map(scanMarket =>
      getSignals(scanMarket, deps, { warmOnly: true }).catch(() => null)
    ));
    const seen = new Set();
    const out = [];
    // Priority order matters: an alias seen in the primary universe wins.
    for (const base of boards) {
      for (const sig of (Array.isArray(base?.signals) ? base.signals : [])) {
        const key = boardSignalKey(sig, mkt);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(sig);
      }
    }
    return out;
  };

  const mainSignalForEntry = async (market, symbol) => {
    const scanMarket = market === 'CRYPTO' ? 'FUTURES' : market;
    const deps = depsForSignals();
    let base = await getSignals(scanMarket, deps, { warmOnly: true }).catch(() => null);
    if (!base?.signals?.length) {
      base = await Promise.race([
        getSignals(scanMarket, deps).catch(() => null),
        new Promise(resolve => { const t = setTimeout(() => resolve(null), 5_000); t.unref?.(); }),
      ]);
    }
    const canon = (v) => normalizeLinkSymbol(String(v || '').toUpperCase().trim().replace(/^B-/, ''), market);
    const wantRaw = String(symbol || '').toUpperCase().trim();
    const want = canon(wantRaw);
    const findIn = (list) => (Array.isArray(list) ? list : []).find(s => {
      const raw = String(s?.symbol || '').toUpperCase().trim();
      return raw === wantRaw || canon(raw) === want;
    }) || null;
    const direct = findIn(base?.signals);
    if (direct || market === 'INDIA' || market === 'GLOBALFUTURES' || market === 'METALS') return direct;
    // An equity/metals-symbol request may arrive with market=CRYPTO or FUTURES
    // (legacy API + board callers). Fall back to the SAME merged desk signals.
    return findIn(await boardSignalsForDesk(market, deps));
  };

  // v6.5: telegram — secrets WIN over env; one resolver, one sender.
  // v20.7.8 [L7]: escape client-derived fields in parse_mode:'HTML'
  // Telegram bodies. An unescaped `<`/`&` in a symbol or close-reason made
  // the Telegram API reject the WHOLE message (400 can't parse entities)
  // — the confirmation push silently never landed. Same helper shape as
  // index.js's escapeHtml (kept local: importing index.js here is a cycle).
  const _tgEsc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const sendTelegram = (text) => sendTelegramMessage(text, { token: TG?.token || '', chatId: TG?.chatId || '' });

  const normMarket = (raw) => {
    const m = String(raw || 'INDIA').toUpperCase();
    // v21.8.0: METALS — GOLD (XAU/USDT) + SILVER (XAG/USDT) dedicated desk
    // v21.22.0: EQUITY_SIM maps to GLOBALFUTURES
    return m === 'CRYPTO' ? 'CRYPTO' : m === 'FUTURES' ? 'FUTURES' : (m === 'GLOBALFUTURES' || m === 'EQUITY_SIM') ? 'GLOBALFUTURES' : m === 'METALS' ? 'METALS' : 'INDIA';
  };

  // ---------------- v21.23.4: RUNTIME DIRECTION CERTIFICATE ----------------
  // Synthetic ground-truth candles se lekar exchange order body tak ka
  // end-to-end proof — "mera build direction ulti compute kar raha hai?"
  // ka EK on-demand jawab. FAIL = computation bug (code inspect karo),
  // PASS = computation sahi (live me ulta dikhe to data-feed/stale-build).
  app.get('/api/ai/direction-selftest', (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(runDirectionSelfTest());
    } catch (e) {
      jsonError(res, 500, 'direction selftest failed', e);
    }
  });

  // ---------------- v21.23.11: LIVE DIRECTION CERTIFICATE ----------------
  // Synthetic selftest computation-layer prove karta hai; YE endpoint REAL
  // network se app ke APNE candle chains audit karta hai — CoinDCX wire
  // drift / mirrored series / scale corruption LIVE pakadta hai. "Signals
  // opposite" complaint ka pehla diagnostic step: (1) /direction-selftest
  // (computation) → (2) /direction-live-certificate (data chains).
  app.get('/api/ai/direction-live-certificate', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const { runLiveDirectionCertificate } = await import('./directionLiveCert.js');
      const r = await runLiveDirectionCertificate();
      res.status(r.pass ? 200 : 503).json(r);
    } catch (e) {
      jsonError(res, 500, 'direction live certificate failed', e);
    }
  });

  // ---------------- v21.23.15: DIRECTION ACCURACY REPORT ----------------
  // Full tracked-signals aggregation (not the UI's 40-row history): hit-rate
  // by desk, side, confidence bucket and directional edge margin. Board rows
  // without engine scores are tolerated and reported as `missingDirScore`.
  app.get('/api/ai/direction-report', (req, res) => {
    try {
      // One clamp lives in getDirectionReport. Parsing here with parseInt()
      // made the route disagree with the aggregation for floats/blank values.
      const tab = String(req.query.tab || req.query.market || 'ALL').trim().toUpperCase();
      res.set('Cache-Control', 'no-store');
      res.json(getDirectionReport(req.query.days, tab));
    } catch (e) {
      jsonError(res, 500, 'direction report failed', e);
    }
  });

  // ---------------- v18.7: AI ENGINE SENTINEL (status + recheck) ----------------
  // The "AI language engines offline" fix: the user finally SEES every
  // engine's real state (no-key / cooldown auto-retry / ready), why it
  // failed (masked lastError), and gets a RECHECK button that clears
  // cooldowns NOW (half-open) + re-probes local ollama. Key values never
  // leave the server — only booleans and error strings.
  app.get('/api/ai/engines', async (_req, res) => {
    try {
      await ollamaProbe().catch(() => false); // refresh the local-engine view (90s cache)
      // v21.24.0 AI TRIO PHASE 1: OpenCode CLI is a separate keyless
      // engine. Never block the strip on a cold CLI probe — kick one
      // off in the background and return the cached view now.
      const opencode = opencodeStatus();
      if (!opencode.probed) void opencodeProbe().catch(() => null);
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        engines: engineSnapshot(effectiveKeys()),
        ollama: ollamaStatus(),
        opencode,
      });
    } catch (e) {
      jsonError(res, 500, 'engine status failed', e);
    }
  });

  app.post('/api/ai/engines/recheck', async (_req, res) => {
    try {
      engineClearCooldowns();               // half-open every engine NOW
      opencodeClearCooldowns();             // OpenCode per-model breaker too
      await Promise.all([
        ollamaProbe(true).catch(() => false), // fresh local probe (bypass cache)
        opencodeProbe(true).catch(() => null), // version/models/auth (never a model call)
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        cleared: true,
        engines: engineSnapshot(effectiveKeys()),
        ollama: ollamaStatus(),
        opencode: opencodeStatus(),
      });
    } catch (e) {
      jsonError(res, 500, 'engine recheck failed', e);
    }
  });

  // v21.24.0 AI TRIO PHASE 1 — manual setup probe.
  // Runs the configured OpenCode seat chain(s) through a tiny strict-JSON
  // prompt. Rate-limited to 1 request / 10s. The browser can choose a
  // seat only; arbitrary models/prompts are rejected by construction.
  app.post('/api/ai/trio/probe', async (req, res) => {
    try {
      const seatArg = String(req.body?.seat || 'all').toLowerCase();
      if (seatArg !== 'all' && !OPENCODE_SEATS.includes(seatArg)) {
        return res.status(400).json({ ok: false, error: 'seat must be fast, deep, sentinel or all' });
      }
      const now = Date.now();
      const waitMs = 10_000 - (now - _trioProbeAt);
      if (_trioProbeAt && waitMs > 0) {
        res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
        return res.status(429).json({
          ok: false,
          error: 'trio probe rate-limited',
          retryAfterSec: Math.ceil(waitMs / 1000),
        });
      }
      _trioProbeAt = now;

      const health = await opencodeProbe(true).catch(() => opencodeStatus());
      if (!health?.available) {
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({
          ok: false,
          phase: 1,
          error: health?.lastError || 'opencode unavailable',
          opencode: health || opencodeStatus(),
          seats: {},
        });
      }

      const seats = seatArg === 'all' ? OPENCODE_SEATS : [seatArg];
      const results = await probeOpenCodeSeats(seats, {
        knownModels: Array.isArray(health.models) ? health.models : [],
      });
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: Object.values(results).every(r => r?.ok === true),
        phase: 1,
        opencode: opencodeStatus(),
        seats: results,
        at: Date.now(),
      });
    } catch (e) {
      jsonError(res, 500, 'trio probe failed', e);
    }
  });

  // ---------------- status ----------------
  app.get('/api/ai/status', async (_req, res) => {
    try {
      const risk = getRiskState();
      const [board, cryptoBoard, futuresBoard] = await Promise.all([
        // v11.4 recheck: warmOnly — a status poll must answer in
        // milliseconds (v9.2.1 latency contract); the default opts ran
        // THREE full multi-desk scans on every cold cache (post-boot,
        // Render wake) → "Agent status unavailable" timeouts.
        getSignals('INDIA', depsForSignals(), { warmOnly: true }).catch(() => null),
        getSignals('CRYPTO', depsForSignals(), { warmOnly: true }).catch(() => null),
        getSignals('FUTURES', depsForSignals(), { warmOnly: true }).catch(() => null),
      ]);
      res.json({
        ok: true,
        engine: 'SUPERINTELLIGENCE ENSEMBLE v6.13 · ORDER TICKET + SIMPLE VIEW',
        models: board?.models || cryptoBoard?.models || [],
        aiCouncilOnline: (board?.models || []).some(m => m.id === 'aicouncil' && m.online),
        risk,
        // v2 signal-accuracy upgrade — 3 new models behind AI_ENABLE_V2_MODELS
        v2Models: {
          enabled: v2ModelsEnabled(),
          flag: 'AI_ENABLE_V2_MODELS',
          newModels: ['sentiment (SentimentPulse)', 'instflow (InstFlow)', 'fundamentals (FundaCheck)'],
          sentiment: sentimentStatus(),
          instFlow: instFlowStatus(),
          fundamentals: fundamentalsStatus(),
        },
        // v11.6: mesh-backed seats — shadow/voting state + the T3 warm
        // view (which caps served, which gapped — budget exhaustion is
        // VISIBLE, never silent).
        meshModels: meshModelsStatusView(),
        // v6.7: self-correcting ensemble + tamper-evident ledger status
        adaptive: adaptiveStatus(),
        ledger: ledgerStatus(),
        dhan: { connected: dhanConnected() },
        telegram: { configured: !!telegramConfig(TG || {}) },
        agent: { enabled: loadAgentConfig().enabled, mode: loadAgentConfig().mode },
        // v18.7: per-engine health (masked) — the offline reason is
        // visible on the status board, not just in desk answers.
        engines: engineSnapshot(effectiveKeys()),
        india: board ? { ok: board.ok, signals: board.signals?.length || 0, marketOpen: board.marketOpen } : null,
        crypto: cryptoBoard ? { ok: cryptoBoard.ok, signals: cryptoBoard.signals?.length || 0 } : null,
        futures: futuresBoard ? { ok: futuresBoard.ok, signals: futuresBoard.signals?.length || 0 } : null,
      });
    } catch (e) {
      jsonError(res, 500, 'ai status failed', e);
    }
  });

  // ---------------- signal board ----------------
  // v12.5 RESCAN: ?rescan=1 → noCache — a FULL fresh universe scan
  // (single-flight protected; the 60s board cache is bypassed exactly
  // once for this request). The board's own 30s client cadence keeps
  // using the cache; the RESCAN button is for "abhi ka fresh top-signal
  // view chahiye" moments (post-news, post-sleep, post-pullback).
  app.get('/api/ai/signals', async (req, res) => {
    try {
      const market = normMarket(req.query.market);
      const limit = Math.min(15, Math.max(3, parseInt(req.query.limit, 10) || 10));
      const rescan = ['1', 'true', 'yes'].includes(String(req.query.rescan || '').trim().toLowerCase());
      // v12.7 BANDWIDTH: `no-cache` (revalidate) instead of the old
      // implicit no-header + the client's ?t= buster — the client polls
      // every 30s while the board cache holds 60s, so ~half the polls
      // were re-downloading a byte-identical 100-400KB body. Express's
      // automatic weak ETag now answers 304 for those (zero body
      // transfer). RESCAN requests carry &rescan=1 (fresh compute →
      // new body → full 200, as they should).
      res.set('Cache-Control', 'no-cache');
      const board = await getSignals(market, depsForSignals(), { limit, ...(rescan ? { noCache: true } : {}) });
      // v18.5 FIX: register the INDIA board's top symbols with the intraday
      // SSE watcher so their LIVE LTP flows to the board cards (⚡ badge,
      // Groww·live source pill). CRYPTO live prices already ride the main
      // /api/stream (tab passes ?crypto=…), so only INDIA needs this.
      // v20.7.9: slice(0,14) → slice(0,15) — the board serves up to 15
      // signals (limit clamp `Math.min(15, …)`); the 15th card silently
      // missed its live-LTP registration.
      try {
        if (market === 'INDIA' && Array.isArray(board?.signals)) {
          const syms = board.signals.slice(0, 15).map(s => s?.symbol).filter(Boolean);
          if (syms.length) intradaySetScanSymbols(syms, 'INDIA');
        }
      } catch { /* never let live-LTP wiring break the board response */ }
      // v20.2: board → track-record accountability (never breaks the response;
      // idempotent per symbol/day — a 60s refresh only bumps conf/lastPrice).
      try { wireBoardAccountability(market, board); } catch { /* optional */ }
      res.json(board);
    } catch (e) {
      jsonError(res, 500, 'ai signals failed', e);
    }
  });

  // ---------------- v20.2 CHART CANDLES (price-chart data) ----------------
  // The signal cards / deep modal finally get real candles: the SAME
  // fetch chain MTF-6 uses (CoinDCX → Binance/Bybit → Yahoo), 60s cache,
  // LTP-scale conversion so overlay levels match the desk's currency.
  // Capped bars, no LLM, no indicators server-side — the SVG renders
  // client-side.
  app.get('/api/ai/candles', async (req, res) => {
    try {
      const symbol = String(req.query.symbol || '').trim();
      // v20.7.12 [L-3]: charset validation (backtest/strategy-lab ka hi
      // treatment — auth'd route hai, par hygiene free hai)
      if (!symbol || !/^[A-Za-z0-9._-]{1,20}$/.test(symbol)) { jsonError(res, 400, 'symbol required (charset [A-Za-z0-9._-], ≤20)'); return; }
      const market = normMarket(req.query.market);
      const tf = String(req.query.tf || '15m').toLowerCase();
      const ltp = Number(req.query.ltp);
      const bars = parseInt(req.query.bars, 10) || 96;
      const out = await chartCandles(symbol, market, tf, { ltp: Number.isFinite(ltp) ? ltp : undefined, bars });
      res.set('Cache-Control', 'no-cache');
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'candles failed', e);
    }
  });

  // ---------------- v20.2 INTRADAY GATE REPLAY HARNESS ----------------
  // Bar-by-bar replay of the QUANT GATE STACK (MTF ladder · chase ·
  // OB/OS · confidence ladder · ATR plan · T1-50%/BE-trail discipline)
  // on historical 5m bars — the tuning instrument the intraday gates
  // never had. Quant-proxy (LLM council not replayed) — labeled.
  app.get('/api/ai/replay', async (req, res) => {
    try {
      const symbol = String(req.query.symbol || '').trim();
      // v20.7.12 [L-3]: charset validation (candles/backtest parity)
      if (!symbol || !/^[A-Za-z0-9._-]{1,20}$/.test(symbol)) { jsonError(res, 400, 'symbol required (charset [A-Za-z0-9._-], ≤20)'); return; }
      const market = normMarket(req.query.market);
      const out = await replayIntradayGates(symbol, { market });
      res.set('Cache-Control', 'no-cache');
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'replay failed', e);
    }
  });

  // ---------------- v8.0 EXPERT PICKS (Advance Pro Trader Engine) ----
  // Whole-universe scan (all liquid CoinDCX spot INR pairs / B-USDT
  // perpetuals / NSE names) → composite 0-100 expert score → only
  // 80+ STRONG picks (default) with a full trade blueprint: entry
  // zone, SL, T1/T2/T3, leverage ladder, staged exit plan, timing
  // window, invalidation. v12.0: har pick ab calibrated WIN
  // PROBABILITY (P(win) vs R:R breakeven + EV in R) bhi laya hai.
  app.get('/api/ai/expert-picks', async (req, res) => {
    try {
      const market = normMarket(req.query.market);
      const minScore = Math.min(99, Math.max(1, parseInt(req.query.minScore, 10) || 80));
      const limit = Math.min(15, Math.max(1, parseInt(req.query.limit, 10) || 12));
      const picks = await getExpertPicks(market, { minScore, limit });
      res.set('Cache-Control', 'no-cache');
      res.json(picks);
    } catch (e) {
      jsonError(res, 500, 'expert picks failed', e);
    }
  });

  // ---------------- v18.4 EXPERT MODE (LOCAL AI: Chronos-T5 + FinBERT) ------
  app.get('/api/ai/expert/analyze/:symbol', async (req, res) => {
    try {
      const market = normMarket(req.query.market);
      const out = await expertAnalyze(req.params.symbol, market, {
        capital: Number(req.query.capital) || 0,
        risk_pct: Number(req.query.risk_pct) || 1,
      });
      res.set('Cache-Control', 'no-cache');
      res.json(out);
    } catch (e) {
      const code = e?.status === 502 ? 502 : 503;
      jsonError(res, code, 'expert analyze failed — ' + (e?.message || String(e)), e);
    }
  });

  app.get('/api/ai/expert/status', async (_req, res) => {
    try {
      res.json(await expertStatus());
    } catch (e) {
      jsonError(res, 503, 'ml-service unreachable — ' + (e?.message || String(e)), e);
    }
  });

  app.post('/api/ai/expert/models/download', async (req, res) => {
    try {
      const model = String(req.body?.model || 'finbert');
      if (!/^(finbert|chronos-small)$/.test(model)) return res.status(400).json({ error: 'model must be finbert or chronos-small' });
      res.json(await expertDownloadModels(model));
    } catch (e) {
      jsonError(res, 503, 'model download failed — ' + (e?.message || String(e)), e);
    }
  });

  app.post('/api/ai/expert/models/warm', async (_req, res) => {
    try {
      res.json(await expertWarmModels());
    } catch (e) {
      jsonError(res, 503, 'model warm failed — ' + (e?.message || String(e)), e);
    }
  });

  // ---------------- v12.0 PERP POSITIONING INTELLIGENCE -------------
  // The CoinDCX GLOBAL FUTURES desk's derivatives-positioning view:
  // funding regime, OI 24h change (longs/shorts building vs squeeze),
  // top-trader L/S ratio, taker buy/sell aggression per symbol —
  // Binance fapi public reference, honest per-field degrade.
  app.get('/api/ai/perp-intel', async (req, res) => {
    try {
      if (!perpIntelEnabled()) {
        return res.json({ ok: false, reason: 'perp intel disabled (AI_DISABLE_PERP_INTEL)', symbols: [] });
      }
      const limit = Math.min(25, Math.max(5, parseInt(req.query.limit, 10) || 12));
      const view = await perpIntelBoardView(limit);
      res.set('Cache-Control', 'no-cache');
      res.json(view);
    } catch (e) {
      jsonError(res, 500, 'perp intel failed', e);
    }
  });

  // ---------------- v21.0 VISION SEAT — chart-screenshot AI analysis ----------------
  // POST /api/ai/vision-check  { symbol, side, image (dataURL), market? }
  // Frontend chart canvas ka PNG base64 bhejta hai → local Ollama vision
  // model (qwen2.5vl:7b / qwen3-vl) visual pattern confirmation deta hai.
  // Vision model installed nahi → honest 503 { reason: 'no-vision-model' }.
  // 10-min per-symbol cache (vision calls 16GB CPU pe ~20-40s lagte hain).
  const _visionCache = new Map();
  app.post('/api/ai/vision-check', async (req, res) => {
    try {
      const { symbol, side, image, market, tf } = req.body || {};
      if (!symbol || !side || !image || typeof image !== 'string' || !image.startsWith('data:image/')) {
        return res.status(400).json({ ok: false, error: 'symbol, side, aur data:image/... image chahiye' });
      }
      if (image.length > 8_000_000) {
        return res.status(413).json({ ok: false, error: 'image bahut badi hai (max ~8M data-URL chars)' });
      }
      const mkt = normMarket(market);
      // v21.0.6 [audit E1]: cache key me TIMEFRAME bhi — pehle 15m chart
      // ka verdict 10-min window me 1d chart ke liye bhi serve ho sakta
      // tha (client tf bhejta nahi tha). Client ab CandleChart ka active tf
      // bhejta hai; unknown/absent tf back-compat ke liye '?' placeholder.
      const tfKey = String(tf || '?').slice(0, 8);
      const cacheKey = `${mkt}:${symbol}:${side}:${tfKey}`;
      const cached = _visionCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 10 * 60_000) {
        return res.json({ ok: true, ...cached.out, cached: true });
      }
      // base64 payload (data-URL prefix strip — Ollama raw base64 chahiye)
      const b64 = image.slice(image.indexOf(',') + 1);
      const prompt = [
        `Analyze this trading chart screenshot for ${symbol} (${mkt} market).`,
        `The quantitative committee's current signal is: ${side}.`,
        'Visually verify: (1) trend structure (HH/HL vs LH/LL), (2) support/resistance proximity,',
        '(3) candlestick patterns at the current price, (4) volume character, (5) overall chart quality for this trade.',
        'Reply STRICT JSON: {"visualTrend":"UP"|"DOWN"|"SIDEWAYS","agreesWithSignal":true|false,"confidence":0-100,"patterns":["..."],"risk":"...","notes":"..."}',
        'Hindi/English mixed notes allowed. Confidence = visual conviction only, not a price target.',
      ].join('\n');
      const { json, model } = await councilAskVision(prompt, [b64]);
      if (!json) {
        const st = ollamaStatus();
        // v21.0.6 [audit E2]: ollama UNREACHABLE apna honest 503 leta hai
        // — pehle stale visionModel field ki wajah se misleading 502
        // ("JSON verdict nahi mila") milta tha jabki asli wajah service
        // down thi. Model-missing 503 pehle jaisa pull-guidance ke saath.
        const unreachable = st.reachable === false;
        const noVision = !st.visionModel;
        return res.status(unreachable || noVision ? 503 : 502).json({
          ok: false,
          error: unreachable
            ? 'ollama service unreachable hai — Ollama chalu karke RECHECK dabao'
            : noVision
              ? 'koi vision model installed nahi (ollama pull qwen2.5vl:7b se install karo)'
              : 'vision model se JSON verdict nahi mila (thodi der baad try karo)',
          ollama: st,
        });
      }
      const out = {
        symbol, side, market: mkt, model,
        visualTrend: String(json.visualTrend || 'SIDEWAYS').toUpperCase().slice(0, 10),
        agreesWithSignal: json.agreesWithSignal === true,
        confidence: Math.max(0, Math.min(100, Math.round(Number(json.confidence) || 0))),
        patterns: Array.isArray(json.patterns) ? json.patterns.slice(0, 6).map(p => String(p).slice(0, 120)) : [],
        risk: String(json.risk || '').slice(0, 300) || null,
        notes: String(json.notes || '').slice(0, 500) || null,
      };
      _visionCache.set(cacheKey, { at: Date.now(), out });
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...out });
    } catch (e) {
      jsonError(res, 500, 'vision check failed', e);
    }
  });

  // ---------------- v21.0 core-seat correlation guard status ----------------
  app.get('/api/ai/seat-correlation', (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(coreSeatGuardStatus());
    } catch (e) {
      jsonError(res, 500, 'seat correlation failed', e);
    }
  });

  // ---------------- deep single-symbol analysis ----------------
  app.get('/api/ai/deep/:symbol', async (req, res) => {
    try {
      const market = normMarket(req.query.market);
      // v20.7.5: ?fresh=1 — a USER-CLICKED 🔬 always runs the ensemble NOW
      // (30s cache read bypassed, single-flight guarded server-side). The
      // 15s modal auto-recheck polls WITHOUT the flag and rides the cache.
      const fresh = String(req.query.fresh || '') === '1';
      const out = await getDeepSignal(req.params.symbol, market, depsForSignals(), fresh ? { fresh: true } : {});
      if (!out?.ok) return res.status(404).json(out);
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'deep signal failed', e);
    }
  });

  // ---------------- v21.15.0 MTF TRADE PLAN (15m→5m · 1h→15m · 5m→1m) ----------------
  // User spec: "15m deep analysis + 5m action" / "1h deep + 15m action".
  // Returns: context read · trigger read · entry/SL/T1/T2 · TF-fit verdict
  // (kya aapka hold window is TF ke travel me fit hai) · cost-in-R ·
  // checklist · warnings · time-plan (BE rule, time-stop, trail).
  app.get('/api/ai/trade-plan/modes', (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, modes: planModeList() });
    } catch (e) {
      jsonError(res, 500, 'plan modes failed', e);
    }
  });

  app.get('/api/ai/trade-plan/:symbol', async (req, res) => {
    try {
      const market = normMarket(req.query.market);
      const out = await getTradePlan(req.params.symbol, market, {
        mode: String(req.query.mode || 'INTRADAY').toUpperCase(),
        holdMin: req.query.hold != null ? Number(req.query.hold) : undefined,
        side: req.query.side ? String(req.query.side).toUpperCase() : undefined,
        ltp: req.query.ltp != null ? Number(req.query.ltp) : undefined,
        capital: req.query.capital != null ? Number(req.query.capital) : undefined,
        riskPctPerTrade: req.query.riskPct != null ? Number(req.query.riskPct) : undefined,
        fresh: String(req.query.fresh || '') === '1',
        fx: await mtfLiveFx(),
      });
      if (!out?.ok) return res.status(404).json(out);
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'trade plan failed', e);
    }
  });

  // v21.17.0 + v21.22.0 — MTF Dual/Auto shared helpers: CoinDCX official
  // 1 USDT = Rs 102 rate (`COINDCX_INR_PER_USDT = 102`) + full USDT perp quote
  // coverage across Crypto + Gold/Silver Metals (`XAU`, `XAG`).
  const mtfLiveFx = async () => {
    try {
      const { COINDCX_INR_PER_USDT } = await import('./futures.js');
      return Number(COINDCX_INR_PER_USDT) || 102;
    } catch { return 102; }
  };
  // v21.23.8 EQUITY SIM auto-trade support: GLOBALFUTURES (USDC sim) quotes
  // ko qualified `GLOBALFUTURES|SYM` keys ke saath auto-trade quote map me
  // overlay karo — deep monitor sweep, evaluatePaper (3s fast loop) aur
  // /mtf-auto/status teeno isi se EQUITY SIM trades ke live price padhte
  // hain (paper engine ka `_quoteFor` inhi qualified keys pe truth dhundta
  // hai; plain-key INR spot quote se cross-domain mix kabhi nahi).
  const mtfGlobalQuoteOverlay = async () => {
    const out = {};
    try {
      const gq = await fetchGlobalLtpMap();
      if (gq && typeof gq.get === 'function') {
        for (const [sym, row] of gq) {
          const px = Number(row?.price ?? row);
          if (sym && px > 0) out[`GLOBALFUTURES|${String(sym).toUpperCase()}`] = { price: px };
        }
      }
    } catch { /* non-fatal — sim trades board-row ltp fallback pe chalte hain */ }
    return out;
  };
  const mtfUsdtQuoteMap = async () => {
    try {
      // v21.23.9: `./metals.js` dead-import fix — fetchMetalsPrices ab
      // futures.js se aata hai (wahi 3-leg metals chain).
      const [{ fetchFuturesPrices, fetchMetalsPrices }] = await Promise.all([
        import('./futures.js'),
      ]);
      const [rows, metalRows] = await Promise.all([
        fetchFuturesPrices({ maxAgeMs: 15000 }).catch(() => null),
        typeof fetchMetalsPrices === 'function' ? fetchMetalsPrices({ maxAgeMs: 15000 }).catch(() => null) : Promise.resolve(null),
      ]);
      const m = new Map();
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const base = String(r?.base || '').toUpperCase();
        const px = Number(r?.last ?? r?.price);
        if (base && px > 0) m.set(base, px);
      }
      for (const r of (Array.isArray(metalRows) ? metalRows : [])) {
        const base = String(r?.base || r?.symbol || '').replace(/^B-/, '').replace(/_USDT$/i, '').toUpperCase();
        const px = Number(r?.last ?? r?.price);
        if (base && px > 0 && !m.has(base)) m.set(base, px);
      }
      return m.size ? m : null;
    } catch { return null; }
  };

  // ---------------- v21.16.0 MTF SIGNALS BOARD (DUAL-TIMEFRAME) ----------------
  // Board ke signals par dual-TF superintelligence: context (deep) TF trend +
  // trigger (action) TF breakout + plan confidence + 6TF extended bias + board
  // base score → EK fused super-score (tier ELITE/STRONG/ACTION/WATCH) +
  // full ticket + TF-fit + auto-link eligibility (koi black box nahi —
  // har row pe autoBlockers[] me exact reason).
  app.get('/api/ai/mtf-dual/board', async (req, res) => {
    try {
      const market = normMarket(req.query.market);
      const cfg = loadMtfAutoConfig();
      const deps = depsForSignals();
      // v21.25.3 [BOARD-SIGNAL COMPLETENESS]: board must see FUTURES +
      // METALS + GLOBALFUTURES signals; otherwise GOLD/SILVER and EQUITY SIM
      // rows lacked their main-AI ensemble and rendered "NOT READY".
      const boardSigs = await boardSignalsForDesk(market, deps);
      const out = await getDualMtfBoard({
        market,
        mode: String(req.query.mode || cfg.mode || 'INTRADAY').toUpperCase(),
        holdMin: req.query.hold != null ? Number(req.query.hold) : cfg.holdMin,
        minScore: req.query.minScore != null ? Number(req.query.minScore) : cfg.minScore,
        limit: req.query.limit != null ? Math.min(TOP_DEEP_TREND_LIMIT, Number(req.query.limit)) : TOP_DEEP_TREND_LIMIT,
        boardSigs,
        fx: await mtfLiveFx(),
        fresh: req.query.fresh === '1' || req.query.fresh === 'true',
      });
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'mtf dual board failed', e);
    }
  });

  /** 🧪 MANUAL PAPER — is dual-board row ke EXACT levels par paper trade.
   *  Levels server hi derive karta hai (client sirf symbol bhejta hai) —
   *  client-trusted prices se trade khulne ka koi raasta nahi. Sizing
   *  auto-link jaisi hi (risk ₹ ÷ |entry−SL|, notional caps, USDT desks
   *  me ₹→USDT conversion). PAPER ONLY. */
  app.post('/api/ai/mtf-dual/paper', async (req, res) => {
    try {
      const body = req.body || {};
      const cfg = loadMtfAutoConfig();
      const market = normMarket(body.market);
      const symbol = String(body.symbol || '').toUpperCase().trim();
      const mode = String(body.mode || cfg.mode || 'INTRADAY').toUpperCase();
      const holdMin = body.hold != null ? Number(body.hold) : cfg.holdMin;
      if (!symbol) return jsonError(res, 400, 'symbol required');
      const fxLive = await mtfLiveFx();
      const mainSignal = await mainSignalForEntry(market, symbol);
      const row = await buildDualRow({ symbol, market, modeId: mode, holdMin, fx: fxLive, boardSig: mainSignal }).catch(() => null);
      if (!row || !row.ok) return jsonError(res, 404, `dual-board row not found for ${symbol} (abhi scan me nahi hai)`);
      if (!(row.side === 'LONG' || row.side === 'SHORT') || !row.plan?.entry || !row.plan?.stopLoss || !row.plan?.t1) {
        return jsonError(res, 400, `${symbol}: tradeable side/levels nahi hain (bias ${row.bias || 'WAIT'})`);
      }
      const gate = mtfProEntryGate(row, {
        mainSignal,
        minScore: Math.max(65, Number(cfg.minScore) || 75),
      });
      if (!gate.ok) {
        const gateMsg = `${symbol}: PAPER ${row.side} blocked - ${gate.blockers.join(' | ')}`;
        return res.status(409).json({ ok: false, blocked: true, error: gateMsg, reason: gateMsg, blockers: gate.blockers, gate });
      }
      if (row.counterHtf) {
        const htfMsg = `${symbol}: PAPER ${row.side} blocked — 1d+4h HTF bias ${row.htfBias || 'opposite'} is against this side (counter-HTF, capped WATCH)`;
        return res.status(409).json({ ok: false, blocked: true, error: htfMsg, reason: htfMsg });
      }
      // v21.25.0 EXPLICIT DIRECTION CERTIFICATE — the paper ticket must prove
      // LONG→buy / SHORT→sell, SL/target polarity and no activePos conflict
      // before it is registered anywhere.
      const rowSide = normalizeSide(row.side);
      const directionCertificate = buildDirectionCertificate({
        symbol: row.symbol || symbol,
        market,
        side: rowSide,
        entry: row.plan?.entry,
        stopLoss: row.plan?.stopLoss,
        t1: row.plan?.t1,
        t2: row.plan?.t2,
        requireTargets: true,
        directionVerified: row.directionVerified === true,
        conflictFlags: {
          boardSideConflict: row.boardSideConflict === true,
          svaConflict: row.svaConflict === true,
          councilConflict: row.councilConflict === true,
          trapVeto: row.trapVeto === true,
          zoneWallVeto: row.zoneWallVeto === true,
          reversalRisk: row.reversalRisk === true,
          counterTrend: row.counterTrend === true,
          counterHtf: row.counterHtf === true,
        },
        source: 'mtf-dual-paper',
      });
      if (!directionCertificate.ok) {
        const certMsg = `${symbol}: PAPER ${rowSide || 'UNKNOWN'} blocked — direction certificate ${directionCertificate.verdict}: ${directionCertificate.reasons[0] || 'invalid direction'}`;
        return res.status(409).json({
          ok: false, blocked: true, error: certMsg, reason: certMsg,
          directionCertificate, orderSide: directionCertificate.orderSide,
        });
      }
      const isUsd = market === 'CRYPTO' || market === 'FUTURES' || market === 'METALS' || market === 'GLOBALFUTURES';
      const execMarket = market === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : isUsd ? 'FUTURES' : 'INDIA';
      const baseSym = normalizeLinkSymbol(row.symbol, market) || symbol;
      // v21.23.14 [MANUAL BOARD LOCK]: board-button entries were the last
      // engine that neither checked nor acquired the cross-engine direction
      // lock - an opposite-side manual PAPER trade could open next to a live
      // auto/agent position. Check before opening; acquire after the position
      // actually exists (release stays with the paper close/60s sweeper).
      const paperLock = checkDirectionLock(baseSym, row.side);
      if (!paperLock.allowed) {
        const lockMsg = `${symbol}: PAPER ${rowSide} blocked - ${paperLock.reason}`;
        return res.status(409).json({ ok: false, blocked: true, error: lockMsg, reason: lockMsg, directionLock: paperLock });
      }
      if (!isUsd) {
        const { isNseMarketOpen, freshEntriesAllowedFor } = await import('../intraday/time.js');
        if (!(isNseMarketOpen() && freshEntriesAllowedFor('INDIA'))) {
          return jsonError(res, 409, 'NSE market closed (or past the 15:00 fresh-entry cutoff) — India paper trade abhi open karne par turant EOD square-off ho jayega; Crypto paper trades 24×7 available hain.');
        }
      }
      const fxRate = (() => { const v = Number(fxLive ?? cfg.inrPerUsdt); return v > 40 && v < 150 ? v : 84; })();
      if (isUsd && market !== 'GLOBALFUTURES') {
        const m = await mtfUsdtQuoteMap();
        const px = m?.get(baseSym);
        if (m && !(px > 0)) return jsonError(res, 409, `${baseSym}: live USDT perp quote available nahi — paper trade manage nahi ho payega`);
      }
      const entry = Number(row.plan.entry), sl = Number(row.plan.stopLoss), t1 = Number(row.plan.t1), t2 = Number(row.plan.t2);
      const riskPerUnit = Math.abs(entry - sl);
      const riskBudget = isUsd ? cfg.riskPerTradeINR / fxRate : cfg.riskPerTradeINR;
      let qty = isUsd ? Math.floor((riskBudget / riskPerUnit) * 10000) / 10000 : Math.floor(riskBudget / riskPerUnit);
      const capQty = isUsd ? (cfg.maxNotionalPerTradeINR / fxRate) / entry : cfg.maxNotionalPerTradeINR / entry;
      if (qty > capQty) qty = isUsd ? Math.floor(capQty * 10000) / 10000 : Math.floor(capQty);
      const minQty = isUsd ? 0.0001 : 1;
      if (!(qty >= minQty)) return jsonError(res, 400, `${baseSym}: qty caps ke baad chhoti pad gayi (SL ${riskPerUnit.toFixed(4)})`);
      const r0 = openPaperTradeExec({
        symbol: baseSym, direction: rowSide, entry, qty, stopLoss: sl, target1: t1, target2: t2,
        market: execMarket,
        source: 'mtf-board-ui',
        sourceMeta: {
          score: row.superScore, tier: row.tier, mode: row.mode, holdMin: row.holdMin, superSymbol: row.symbol,
          directionVerified: row.directionVerified === true, triggerFired: row.triggerFired === true,
          htfBias: row.htfBias ?? null, mainSignalSide: mainSignal?.side ?? null,
          mainSignalGrade: mainSignal?.grade ?? null, mainSignalConfidence: mainSignal?.confidence ?? null,
          orderSide: directionCertificate.orderSide,
          directionVerdict: directionCertificate.verdict,
          directionCertificate: {
            version: directionCertificate.version,
            side: directionCertificate.side,
            orderSide: directionCertificate.orderSide,
            verdict: directionCertificate.verdict,
            ok: directionCertificate.ok,
            label: directionCertificate.label,
          },
          entryGate: 'PRO_V1',
        },
        label: `MTF BOARD · ${row.tier} ${row.superScore} · ${row.label} ${row.holdMin}m · ${isUsd ? 'USDT' : '₹'}`,
      });
      if (r0?.error) return jsonError(res, 400, r0.error);
      try {
        acquireDirectionLock({
          symbol: baseSym, side: rowSide, source: 'mtf-board-paper',
          cooldownMin: Number(cfg.flipReentryBlockMin) || 240,
        });
      } catch { /* lock is best-effort - an already-open paper position must stay manageable */ }
      // v21.22.0: Register Paper Trade into Auto-Trade Deep Monitor so real-time Direction Follow-Through
      // ("pakka jo direction trade signal mila hai vo follow kar raha hai kya") & Ultra-Fast Auto SL Trail
      // are tracked live on the MTF Dual Board and Signal Recheck panels.
      try {
        recordPaperMtfBoardTrade({
          paperId: r0.trade?.id ?? `PAPER_${baseSym}_${Date.now()}`,
          symbol: baseSym,
          market,
          side: rowSide,
          entry,
          stopLoss: sl,
          t1,
          t2,
          qty,
          fx: fxRate,
          superScore: row.superScore,
          tier: row.tier,
          mode: row.mode,
          holdMin: row.holdMin,
        });
      } catch { /* non-fatal */ }
      res.json({
        ok: true, trade: r0.trade, ccy: isUsd ? 'USDT' : 'INR', fx: isUsd ? fxRate : null,
        orderSide: directionCertificate.orderSide,
        signalToOrder: `${rowSide} → ${directionCertificate.orderSideLabel}`,
        directionCertificate,
        row: {
          symbol, side: rowSide, orderSide: directionCertificate.orderSide,
          signalToOrder: `${rowSide} → ${directionCertificate.orderSideLabel}`,
          directionVerdict: directionCertificate.verdict,
          directionCertificate,
          superScore: row.superScore, tier: row.tier, tfFit: row.tfFit, autoEligible: row.autoEligible, blockers: row.autoBlockers,
        },
      });
    } catch (e) {
      jsonError(res, 500, 'mtf board paper failed', e);
    }
  });

  /** ⚡ v21.20.0 DIRECT MTF BOARD LIVE ORDER — places the exact trade signal
   *  shown on the MTF Dual-Timeframe Signal Board on CoinDCX Futures (using
   *  .env COINDCX_API_KEY + COINDCX_SECRET or saved credentials) with wallet-tier
   *  leverage (< ₹10,000 → 10x, ≥ ₹10,000 → 5x) and native TP/SL protection. */
  app.post('/api/ai/mtf-dual/live', async (req, res) => {
    try {
      const body = req.body || {};
      const cfg = loadMtfAutoConfig();
      // v21.25.3 [PHASE-0 PAUSE HONESTY]: pause ka matlab "naye LIVE/UC-flip
      // entries band" hai — manual board ka ⚡ LIVE button bhi naya real-money
      // entry hai. Pehle sirf auto engine pause respect karta tha, manual
      // click pause ke through real order bhej deta tha. PAPER test clicks
      // is guard se affect nahi hote (alag endpoint).
      if (cfg.liveEntryPaused === true) {
        const pauseMsg = 'LIVE entries Phase 0 me PAUSED hain — naye manual/auto LIVE orders band. Existing positions ka SL/deep-monitor management chalu hai. Resume entries karke retry karo.';
        return res.status(409).json({ ok: false, blocked: true, paused: true, error: pauseMsg, reason: pauseMsg });
      }
      const market = normMarket(body.market || 'CRYPTO');
      const symbol = String(body.symbol || '').toUpperCase().trim();
      const mode = String(body.mode || cfg.mode || 'INTRADAY').toUpperCase();
      const holdMin = body.hold != null ? Number(body.hold) : cfg.holdMin;
      if (!symbol) return jsonError(res, 400, 'symbol required');

      // v21.23.14 [SIM LIVE DOUBLE-WALL]: GLOBALFUTURES/EQUITY SIM is a PAPER
      // desk. This endpoint previously fell through the `isUsd` check into the
      // INDIA/Dhan branch for market=GLOBALFUTURES - a direct API caller could
      // send an equity SIM row to the wrong broker. UI already hides LIVE.
      if (market === 'GLOBALFUTURES') {
        return jsonError(res, 400, `${symbol}: GLOBALFUTURES/EQUITY SIM is PAPER-only - live execution not supported`);
      }

      const fxLive = await mtfLiveFx();
      const mainSignal = await mainSignalForEntry(market, symbol);
      const row = await buildDualRow({ symbol, market, modeId: mode, holdMin, fx: fxLive, boardSig: mainSignal }).catch(() => null);
      if (!row || !row.ok) {
        return jsonError(res, 404, `MTF Dual Board row not found for ${symbol}`);
      }
      const requestedRawSide = body.side ?? null;
      const requestedSide = normalizeSide(requestedRawSide);
      if (requestedRawSide != null && !requestedSide) {
        return jsonError(res, 400, `${symbol}: invalid requested side "${String(requestedRawSide)}" — LONG/BUY ya SHORT/SELL required`);
      }
      const freshRowSide = normalizeSide(row.side);
      if (requestedSide && freshRowSide && requestedSide !== freshRowSide) {
        const flipMsg = `${symbol}: signal direction flipped from ${requestedSide} to ${freshRowSide} on live recheck — anti-reversal guard blocked stale entry`;
        return res.status(409).json({ ok: false, blocked: true, error: flipMsg, reason: flipMsg });
      }
      const side = freshRowSide || requestedSide;
      if (side !== 'LONG' && side !== 'SHORT') {
        return jsonError(res, 400, `${symbol}: directional signal (LONG/SHORT) required`);
      }
      const proGate = mtfProEntryGate(row, {
        mainSignal,
        minScore: Math.max(65, Number(cfg.minScore) || 75),
      });
      if (!proGate.ok) {
        const gateMsg = `${symbol}: LIVE order blocked - ${proGate.blockers.join(' | ')}`;
        return res.status(409).json({ ok: false, blocked: true, error: gateMsg, reason: gateMsg, blockers: proGate.blockers, gate: proGate });
      }
      const dirGateHits = [];
      if (row.counterHtf) dirGateHits.push(`1d+4h HTF bias ${row.htfBias || 'opposite'} against ${side}`);
      if (row.counterTrend) dirGateHits.push('counter-trend setup');
      if (row.boardSideConflict) dirGateHits.push(`board ensemble ${row.boardSide || 'opposite'} vs ${side}`);
      if (row.svaConflict) dirGateHits.push('SVA verifier FLIP');
      if (row.councilConflict) dirGateHits.push('AI council hard-no');
      if (row.reversalRisk || row.trigger?.opposingFlow) dirGateHits.push('active reversal / opposing flow');
      if (!row.directionVerified) dirGateHits.push('direction not pakka verified');
      if (Number(row.superScore) < 65) dirGateHits.push(`score ${row.superScore} < ACTION floor 65`);
      if (dirGateHits.length) {
        const gateMsg = `${symbol}: LIVE order blocked — ${dirGateHits.join(' · ')}`;
        return res.status(409).json({ ok: false, blocked: true, error: gateMsg, reason: gateMsg });
      }
      if (row.trapVeto || row.zoneWallVeto || row.reversalRisk || row.trigger?.opposingFlow) {
        const vetoMsg = `${symbol}: ${row.trapVeto ? 'Liquidity Sweep Trap Veto' : row.zoneWallVeto ? 'Fresh Supply/Demand Zone Wall Veto' : 'Active Bar Reversal / Exhaustion Risk'} detected — entry blocked`;
        return res.status(409).json({ ok: false, blocked: true, error: vetoMsg, reason: vetoMsg });
      }
      const pEntry = Number(row.plan?.entry);
      const pSl = Number(row.plan?.stopLoss);
      if (pEntry > 0 && pSl > 0) {
        const badPolarity = (side === 'LONG' && pSl >= pEntry) || (side === 'SHORT' && pSl <= pEntry);
        if (badPolarity) {
          const polMsg = `${symbol}: invalid SL polarity (${side} entry ${pEntry} vs SL ${pSl}) — order blocked`;
          return res.status(409).json({ ok: false, blocked: true, error: polMsg, reason: polMsg });
        }
      }
      // v21.25.0 EXPLICIT DIRECTION CERTIFICATE — signal side, exchange order
      // side, SL/target geometry and activePos consistency are proven BEFORE
      // the broker call. Any inversion is a hard block, never a silent LONG.
      const directionCertificate = buildDirectionCertificate({
        symbol: row.symbol || symbol,
        market,
        side,
        entry: row.plan?.entry,
        stopLoss: row.plan?.stopLoss,
        t1: row.plan?.t1,
        t2: row.plan?.t2,
        requireTargets: true,
        directionVerified: row.directionVerified === true,
        conflictFlags: {
          boardSideConflict: row.boardSideConflict === true,
          svaConflict: row.svaConflict === true,
          councilConflict: row.councilConflict === true,
          trapVeto: row.trapVeto === true,
          zoneWallVeto: row.zoneWallVeto === true,
          reversalRisk: row.reversalRisk === true,
          counterTrend: row.counterTrend === true,
          counterHtf: row.counterHtf === true,
        },
        source: 'mtf-dual-live',
      });
      if (!directionCertificate.ok) {
        const certMsg = `${symbol}: LIVE ${side} blocked — direction certificate ${directionCertificate.verdict}: ${directionCertificate.reasons[0] || 'invalid direction'}`;
        return res.status(409).json({
          ok: false, blocked: true, error: certMsg, reason: certMsg,
          directionCertificate, orderSide: directionCertificate.orderSide,
        });
      }

      const isUsd = market === 'CRYPTO' || market === 'FUTURES' || market === 'METALS';
      const baseSym = normalizeLinkSymbol(row.symbol, market) || symbol;
      // v21.23.14 [MANUAL BOARD LOCK]: live button entries must obey the same
      // cross-engine direction lock as auto/agent/SAPTA. Check BEFORE touching
      // the broker; acquire only after a real fill (paper mirror excluded).
      const liveLock = checkDirectionLock(baseSym, side);
      if (!liveLock.allowed) {
        const lockMsg = `${symbol}: LIVE ${side} blocked - ${liveLock.reason}`;
        return res.status(409).json({ ok: false, blocked: true, error: lockMsg, reason: lockMsg, directionLock: liveLock });
      }
      const activeSt = mtfAutoStatus();
      // v21.23.18 [PAPER != LIVE LOCK]: 1-session-1-trade lock sirf LIVE rows
      // par lagta hai. Ek open PAPER test trade real LIVE board order ko
      // indefinitely block nahi karega.
      const activeSessionTrades = (activeSt?.deepMonitor?.trades || []).filter(t =>
        t.traded !== false
        && (String(t.executionMode || '').toUpperCase() === 'LIVE' || Boolean(t.livePositionId)),
      );
      if (activeSessionTrades.length >= 1) {
        const cur = activeSessionTrades[0];
        const lockMsg = `1 session = 1 trade lock: ${cur.symbol} (${cur.side}) is already active — next trade will open only after ${cur.symbol} finishes`;
        return res.status(409).json({ ok: false, blocked: true, error: lockMsg, reason: lockMsg });
      }
      if (isUsd) {
        const liveOut = await executeMtfDualLiveOrder({
          symbol: baseSym,
          side,
          leverage: body.leverage != null ? Number(body.leverage) : undefined,
          entry: row.plan?.entry,
          stopLoss: row.plan?.stopLoss,
          t1: row.plan?.t1,
          t2: row.plan?.t2,
          superScore: row.superScore,
          tier: row.tier,
          mode: row.mode || mode,
          source: 'mtf-board-live-ui',
        });
        if (!liveOut?.ok) {
          return res.status(liveOut?.blocked ? 400 : 422).json({
            ok: false,
            error: liveOut?.error || liveOut?.reason || 'Live order execution failed',
            reason: liveOut?.reason || liveOut?.error || 'Live order execution failed',
          });
        }
        // Register in paper mirror + Auto-Trade Deep Monitor book so 15s Signal Recheck
        // and 5-Stage Dynamic SL Trailing monitor this live order until TP1/TP2 or reversal exit!
        try {
          acquireDirectionLock({
            symbol: baseSym, side, source: 'mtf-board-live',
            cooldownMin: Number(cfg.flipReentryBlockMin) || 240,
          });
        } catch { /* lock is best-effort - a filled exchange position must stay manageable */ }
        const filled = liveOut.filled || {};
        const paperMirror = openPaperTradeExec({
          symbol: baseSym,
          direction: side,
          entry: Number(filled.price ?? row.plan?.entry),
          qty: Number(filled.qty ?? row.plan?.qty ?? 1),
          stopLoss: Number(filled.stopLoss ?? row.plan?.stopLoss),
          target1: Number(filled.t1 ?? row.plan?.t1),
          target2: Number(filled.t2 ?? row.plan?.t2),
          market: 'FUTURES',
          leverage: Number(filled.leverage ?? body.leverage ?? 10),
          source: 'mtf-auto',
          label: `MTF LIVE · ${row.tier} ${row.superScore} · ${filled.leverage ?? 10}x (100% Wallet)`,
        });
        recordLiveMtfBoardTrade({
          paperId: paperMirror?.trade?.id ?? null,
          orderId: liveOut.orderId,
          positionId: liveOut.position?.id ?? null,
          symbol: baseSym,
          market: 'CRYPTO',
          side,
          entry: Number(filled.price ?? row.plan?.entry),
          stopLoss: Number(filled.stopLoss ?? row.plan?.stopLoss),
          t1: Number(filled.t1 ?? row.plan?.t1),
          t2: Number(filled.t2 ?? row.plan?.t2),
          qty: Number(filled.qty ?? row.plan?.qty ?? 1),
          leverage: Number(filled.leverage ?? body.leverage ?? 10),
          walletINR: filled.walletTotalINR ? Math.round(filled.walletTotalINR) : (filled.walletDeployINR ? Math.round(filled.walletDeployINR) : cfg.walletAmountINR),
          deployedWalletINR: filled.walletDeployINR ?? null,
          buyingPowerINR: filled.buyingPowerINR ?? null,
          superScore: row.superScore,
          tier: row.tier,
          mode: row.mode || mode,
          holdMin: row.holdMin || holdMin,
          fx: fxLive,
        });
        return res.json({
          ok: true,
          mode: 'live',
          orderId: liveOut.orderId,
          position: liveOut.position,
          filled: liveOut.filled,
          orderSide: liveOut.orderSide || directionCertificate.orderSide,
          signalToOrder: `${side} → ${(liveOut.orderSide || directionCertificate.orderSide || 'no-order').toUpperCase()}`,
          directionCertificate: liveOut.directionCertificate || directionCertificate,
          signalCertificate: directionCertificate,
          row: {
            symbol: baseSym, side, orderSide: liveOut.orderSide || directionCertificate.orderSide,
            signalToOrder: `${side} → ${(liveOut.orderSide || directionCertificate.orderSide || 'no-order').toUpperCase()}`,
            directionVerdict: directionCertificate.verdict,
            directionCertificate,
            superScore: row.superScore, tier: row.tier, mode: row.mode,
          },
        });
      }

      // India desk live execution
      const outIndia = await executeIndiaSignal({
        symbol: baseSym, side, mode: 'live',
        // v21.23.10 CRITICAL FIX: `getFreshSignal` → `getFreshIndiaSignal`
        // (executeIndiaSignal ka destructure naam) — pehle India arm hote hi
        // gate-4 TypeError deta tha → manual MTF board India LIVE bhi dead.
        // v21.23.12 FIX (recheck HIGH — v21.23.10 ka "CRITICAL FIX" sirf param
        // ka naam theek karta tha, function nahi): getFreshSignalForExec
        // (pairOrSymbol, deps, opts) me market param HAI HI NAHI — 'INDIA'
        // string deps-slot me jaati thi, real deps opts-slot me, aur market
        // hardcoded 'CRYPTO' rehta tha → India symbol CRYPTO deep branch me
        // (RELIANCE pe fetchTVCryptoBatch) guaranteed fail → gate-4 hamesha
        // "No fresh ensemble signal available" → manual MTF board India LIVE
        // STRUCTURALLY dead. Correct pattern (routes.js /india/execute +
        // indiaAgent.js jaisa): getDeepSignal(sym,'INDIA',deps).
        getFreshIndiaSignal: async (sym) => {
          const deep = await getDeepSignal(sym, 'INDIA', depsForSignals()).catch(() => null);
          return deep?.ok ? deep.signal : null;
        },
        source: 'mtf-board-live-ui', sendTelegram,
      });
      if (!outIndia?.ok) {
        return res.status(400).json({ ok: false, error: outIndia?.error || outIndia?.reason || 'India live order failed' });
      }
      try {
        acquireDirectionLock({
          symbol: baseSym, side, source: 'mtf-board-live',
          cooldownMin: Number(cfg.flipReentryBlockMin) || 240,
        });
      } catch { /* lock is best-effort - a filled broker position must stay manageable */ }
      const iFilled = outIndia.filled || {};
      recordLiveMtfBoardTrade({
        orderId: outIndia.orderId ?? null,
        // v21.23.15 recheck: without the India journal position id the
        // deep-monitor close path cannot find the Dhan position (it used to
        // fall through to the CoinDCX close handler).
        positionId: outIndia.position?.id ?? outIndia.positionId ?? outIndia.orderId ?? null,
        symbol: baseSym,
        market: 'INDIA',
        side,
        // v21.23.14: anchor the live book to the BROKER fill, not the board
        // plan. Dhan may fill with slippage/partial qty; plan levels would
        // corrupt every downstream SL/TP/P&L calculation.
        entry: Number(iFilled.price) > 0 ? Number(iFilled.price) : Number(row.plan?.entry),
        stopLoss: Number(outIndia.position?.sl) > 0 ? Number(outIndia.position.sl) : Number(row.plan?.stopLoss),
        t1: Number(outIndia.position?.tp) > 0 ? Number(outIndia.position.tp) : Number(row.plan?.t1),
        t2: Number(outIndia.position?.tp2) > 0 ? Number(outIndia.position.tp2) : Number(row.plan?.t2),
        qty: Number(iFilled.qty) > 0 ? Number(iFilled.qty) : Number(outIndia.position?.qty ?? row.plan?.qty ?? 1),
        leverage: 5,
        walletINR: cfg.walletAmountINR,
        superScore: row.superScore,
        tier: row.tier,
        mode: row.mode || mode,
        holdMin: row.holdMin || holdMin,
      });
      return res.json({
        ok: true, mode: 'live', ...outIndia,
        orderSide: directionCertificate.orderSide,
        signalToOrder: `${side} → ${directionCertificate.orderSideLabel}`,
        directionCertificate,
        row: {
          symbol: baseSym, side, orderSide: directionCertificate.orderSide,
          signalToOrder: `${side} → ${directionCertificate.orderSideLabel}`,
          directionVerdict: directionCertificate.verdict,
          directionCertificate,
          superScore: row.superScore, tier: row.tier, mode: row.mode,
        },
      });
    } catch (e) {
      jsonError(res, 500, 'mtf board live order failed', e);
    }
  });

  // ---------------- v21.16.0 + v21.20.0 MTF AUTO-LINK (PAPER + LIVE) ----------------
  // Config + status + toggle + manual dry-run/tick. Auto loop (60s) neeche
  // register hota hai — same tick function chalata hai.
  // v21.20.0: Direct CoinDCX Futures Live Order execution via executeMtfDualLiveOrder
  // using .env COINDCX_API_KEY + COINDCX_SECRET + wallet-tier leverage (10x / 5x).
  /**
   * Single source of truth for MTF live readiness. `siteLiveByDesk` is the
   * exchange/legacy-desk live state; `deskReady` says the desk can actually
   * execute right now; `deskArmable` says the prerequisites for the UI's LIVE
   * button are met (India still needs its typed-LIVE arming).
   */
  const mtfAutoReadiness = (cfg) => {
    const tcfg = (() => { try { return loadConfig() || {}; } catch { return {}; } })();
    const hasCreds = Boolean(loadCredsForOrder());
    const killSwitch = tcfg.killSwitch === true;
    const desks = {
      crypto: cfg?.desks?.crypto !== false,
      india: cfg?.desks?.india !== false,
    };
    const siteLiveByDesk = {
      crypto: Boolean(desks.crypto && !killSwitch && tcfg.mode === 'live' && (tcfg.allowAuto || hasCreds)),
      // India live is NEVER inferred from the crypto/site mode or the MTF
      // executionMode. It requires the separate typed-LIVE India arming.
      india: Boolean(desks.india && !killSwitch && tcfg.indiaMode === 'live'),
    };
    const siteLiveActive = siteLiveByDesk.crypto || siteLiveByDesk.india;
    const cryptoWhy = !desks.crypto ? 'Crypto desk is OFF in Auto Trade config'
      : killSwitch ? 'Global kill switch is ON — trading disabled'
      : !hasCreds ? 'CoinDCX API keys not connected — add COINDCX_API_KEY + COINDCX_SECRET in .env or connect in Portfolio tab'
      : tcfg.mode !== 'live' ? 'Crypto site live is not armed — arm crypto LIVE (or click LIVE here)'
      : null;
    const indiaWhy = !desks.india ? 'India desk is OFF in Auto Trade config'
      : killSwitch ? 'Global kill switch is ON — trading disabled'
      : tcfg.indiaMode !== 'live' ? 'India LIVE mode is not armed — type LIVE in the India console first (separate from crypto)'
      : null;
    return {
      tcfg,
      hasCreds,
      killSwitch,
      desks,
      siteLiveByDesk,
      siteLiveActive,
      deskReady: {
        crypto: { ready: hasCreds && siteLiveByDesk.crypto, why: cryptoWhy },
        india: { ready: siteLiveByDesk.india, why: indiaWhy },
      },
      deskArmable: {
        crypto: { armable: !killSwitch && desks.crypto && hasCreds, why: cryptoWhy },
        india: { armable: !killSwitch && desks.india && tcfg.indiaMode === 'live', why: indiaWhy },
      },
    };
  };

  const mtfAutoLiveCtx = async (cfg) => {
    const { tcfg, hasCreds: hasEnvOrSavedCreds, siteLiveByDesk, siteLiveActive, killSwitch, desks } = mtfAutoReadiness(cfg);
    // v21.23.14 [DESK SCOPE]: crypto and India live are independent sessions.
    // Keep the boolean for old consumers, but the engine must receive the
    // per-desk map - India-live must never arm CRYPTO live auto (or reverse).
    let walletEquityINR = Number(cfg?.walletAmountINR) || 10000;
    try {
      const w = await Promise.race([
        walletSnapshot().catch(() => null),
        new Promise(r => { const t = setTimeout(() => r(null), 2500); t.unref?.(); }),
      ]);
      const fx = 102; // Official CoinDCX Futures conversion rate: 1 USDT = Rs 102
      const futDeployableINR = Math.round((Number(w?.deployableFuturesUSDT) || 0) * fx + (Number(w?.deployableFuturesINR) || 0));
      if (futDeployableINR > 0) walletEquityINR = futDeployableINR;
      else if (Number(w?.equityINR) > 0) walletEquityINR = Number(w.equityINR);
      // NOTE: do NOT write the wallet snapshot back into MTF config here. This
      // context is built on every tick/status poll; the write used to run
      // before durable boot restore and could stamp a newer default config
      // over the restored one. Sizing already gets walletEquityINR directly.
    } catch { /* fallback to cfg.walletAmountINR */ }
    const syncLivePositions = async () => {
      try {
        const ctrl = await syncCoinDcxActivePositionsForControl();
        if (ctrl?.ok) {
          syncCoinDcxActivePositionsToDeepMonitor(ctrl.positions || [], {
            authoritativeExchangeList: ctrl.authoritativeExchangeList,
            walletINR: walletEquityINR,
          });
        }
      } catch { /* non-fatal */ }
    };
    const liveExecute = async (order) => {
      if (order.market === 'FUTURES' || order.market === 'CRYPTO' || order.market === 'METALS') {
        // v21.23.10 [DESK-PRE-FLIGHT]: creds absent = GUARANTEED reject —
        // pehle engine har candidate par poora executeMtfDualLiveOrder ladder
        // (wallet fetch + 7-rung order POSTs + journal FAILED row) chalata
        // tha. Ab pre-flight honest blocked verdict — engine per-symbol backoff
        // stamp karta hai, gauntlet/journal spam nahi hota.
        if (!hasEnvOrSavedCreds) {
          return { ok: false, blocked: true, reason: 'CoinDCX API key & secret not connected — add COINDCX_API_KEY + COINDCX_SECRET in .env or connect in Portfolio tab', error: 'CoinDCX API key & secret not connected' };
        }
        return executeMtfDualLiveOrder({
          symbol: order.symbol,
          side: order.side,
          leverage: order.leverage,
          walletDeployPct: order.walletDeployPct ?? 100,
          entry: order.entry,
          stopLoss: order.stopLoss,
          t1: order.target1,
          t2: order.target2,
          superScore: order.row?.superScore ?? null,
          tier: order.row?.tier ?? null,
          mode: order.row?.mode || cfg?.mode || 'INTRADAY',
          source: 'mtf-auto-live',
        });
      }
      if (order.market === 'INDIA') {
        // v21.23.10 [DESK-PRE-FLIGHT]: India desk un-armed = GUARANTEED
        // gate-2 reject (indiaOrders 'type LIVE in the console first') —
        // live-probe me is reject ne minutes me ~100 journal REJECTED rows
        // mint kiye. Ab engine-side pre-flight + honest source tag.
        if (tcfg.indiaMode !== 'live') {
          return { ok: false, blocked: true, reason: 'India LIVE mode is not armed — type LIVE in the console first (India arming is separate from crypto)', error: 'India LIVE mode is not armed' };
        }
        const qtyINR = Math.round((order.qty || 1) * (order.entry || 0));
        return executeIndiaSignal({
          symbol: order.symbol, side: order.side, mode: 'live',
          qtyINR,
          // v21.23.10 CRITICAL FIX: param ka naam `getFreshSignal` tha jabki
          // executeIndiaSignal `getFreshIndiaSignal` destructure karta hai —
          // India arm hote hi gate-4 `getFreshIndiaSignal(sym)` TypeError
          // deta (undefined call) → MTF-auto India LIVE STRUCTURALLY dead.
          // Manual console path (1979) pehle se sahi naam use karta tha.
          // v21.23.12 FIX: upar wala hi arity bug — getDeepSignal(sym,'INDIA',…)
          // hi sahi wiring hai (mtf-auto India LIVE isi se chalta hai ab).
          getFreshIndiaSignal: async (sym) => {
            const deep = await getDeepSignal(sym, 'INDIA', depsForSignals()).catch(() => null);
            return deep?.ok ? deep.signal : null;
          },
          source: 'mtf-auto-india', sendTelegram,
        });
      }
      return { ok: false, error: 'unsupported live market' };
    };
    const liveUpdateSl = async (trade) => {
      // India SL is protective at the broker; modifying it through the
      // CoinDCX handler would send a malformed request at the wrong exchange.
      const mkt = String(trade?.execMarket || trade?.market || '').toUpperCase();
      if (mkt === 'INDIA') {
        return { ok: false, skipped: true, reason: 'India SL is broker-managed — software monitor closes via the India desk' };
      }
      return updateCoinDcxPositionSl({
        positionId: trade?.livePositionId,
        symbol: trade?.symbol,
        pair: trade?.pair,
        stopLoss: trade?.stopLoss,
        takeProfit: trade?.takeProfit,
      }).catch(() => null);
    };
    const liveClose = async (trade) => {
      // Route the close to the desk that owns the position. The old
      // unconditional CoinDCX close sent India rows to the wrong exchange.
      const mkt = String(trade?.execMarket || trade?.market || '').toUpperCase();
      if (mkt === 'INDIA') {
        const id = trade?.livePositionId || trade?.liveOrderId || trade?.positionId;
        if (!id) return { ok: false, error: 'India live position id missing' };
        return closeIndiaPosition(String(id), { reason: 'MTF auto deep-monitor close' }).catch(() => null);
      }
      return closeCoinDcxActivePosition({
        positionId: trade?.livePositionId,
        symbol: trade?.symbol,
        pair: trade?.pair,
      }).catch(() => null);
    };
    return {
      siteLiveActive,
      siteLiveByDesk,
      walletEquityINR,
      killSwitch,
      desks,
      syncLivePositions,
      liveExecute,
      liveUpdateSl,
      liveClose,
      coindcxConnected: hasEnvOrSavedCreds,
    };
  };

  // ------------------------------------------------------------
  // v21.26.0 AI SUPER AGENT — injected server deps.
  // The tick agent itself is pure route-agnostic (autoTradeSuperAgent.js);
  // these adapters give it the same quote / board / live-handler truth the
  // 15s and 60s sweeps already use.
  // ------------------------------------------------------------
  const SUPER_AGENT_LIVE_CTX_TTL_MS = 15_000;
  let _superAgentLiveCtx = null;
  let _superAgentLiveCtxAt = 0;
  let _superAgentLiveCtxP = null;

  /** Cached live context. Wallet snapshots are far too expensive for a WS
   *  tick path; the handlers themselves (close/SL/execute) are stateless. */
  const getSuperAgentLiveCtx = async () => {
    const now = Date.now();
    if (_superAgentLiveCtx && now - _superAgentLiveCtxAt < SUPER_AGENT_LIVE_CTX_TTL_MS) return _superAgentLiveCtx;
    if (_superAgentLiveCtxP) return _superAgentLiveCtxP;
    const p = mtfAutoLiveCtx(loadMtfAutoConfig())
      .then((lc) => {
        if (lc && typeof lc === 'object') {
          _superAgentLiveCtx = lc;
          _superAgentLiveCtxAt = Date.now();
        }
        return lc;
      })
      .finally(() => { _superAgentLiveCtxP = null; });
    _superAgentLiveCtxP = p;
    return p;
  };

  /** One market-qualified quote from the server stream cache. This is the
   *  FALLBACK path only — liveFeed's WebSocket tick is primary. */
  const superAgentQuoteFor = (symbol, market, execMarket = null) => {
    const raw = String(symbol || '').toUpperCase().trim();
    if (!raw) return null;
    const mk = String(market || '').toUpperCase();
    const exec = String(execMarket || mk || '').toUpperCase();
    const sym = normalizeLinkSymbol(raw, mk || exec);
    if (!sym) return null;
    const data = getLatestQuotes()?.data || {};
    const keys = [
      `${exec}|${sym}`, `${mk}|${sym}`, `${exec}|${raw}`, `${mk}|${raw}`,
      sym, raw,
    ];
    const usdDesk = ['FUTURES', 'GLOBALFUTURES', 'METALS', 'CRYPTO'].includes(exec)
      || ['FUTURES', 'GLOBALFUTURES', 'METALS', 'CRYPTO'].includes(mk);
    for (const key of keys) {
      if (!key) continue;
      const row = data[key];
      const px = typeof row === 'object' ? Number(row?.price ?? row?.ltp) : Number(row);
      if (!(px > 0)) continue;
      // Plain symbol keys can be INR spot while the trade is USDT/USDC.
      // Qualified keys are authoritative; reject a plain INR source for USD.
      if (usdDesk && !String(key).includes('|') && /inr/i.test(String(row?.src || ''))) continue;
      return px;
    }
    return null;
  };

  /** Freshest warm MTF row for an open trade (top-6 rotation safe: the agent
   *  also has its own 120s snapshot fallback inside mtfAutoLink). */
  const superAgentBoardRow = (symbol, market = null) => {
    const mk = String(market || '').toUpperCase();
    const want = normalizeLinkSymbol(symbol, mk || 'CRYPTO');
    if (!want) return null;
    for (const board of peekDualMtfBoards(120_000)) {
      const bm = String(board?.market || '').toUpperCase();
      const deskMatches = bm === mk
        || ((mk === 'CRYPTO' || mk === 'FUTURES' || mk === 'METALS' || mk === 'GLOBALFUTURES')
          && bm === 'CRYPTO');
      if (!deskMatches) continue;
      const rows = [
        ...(board?.rows || []),
        ...(board?.metalsRows || []),
        ...(board?.equitySimRows || []),
      ];
      const row = rows.find(r => r && normalizeLinkSymbol(r.symbol, mk || bm) === want);
      if (row) return row;
    }
    return null;
  };

  // A2 FIX: throttle exchange sync in /status — single-flighted + 10s TTL.
  // Background tick (lines 3296/3483) already syncs; /status polls (2-5s) don't
  // need fresh sync every time. Prevents CoinDCX rate-limit/timeouts that cascade
  // into A1 (config save "failed" because /status timed out).
  let _statusSyncAt = 0, _statusSyncP = null;
  async function syncLiveThrottled(liveCtx, ttlMs = 10_000) {
    if (_statusSyncP) return _statusSyncP;
    if (Date.now() - _statusSyncAt < ttlMs) return;
    _statusSyncP = liveCtx.syncLivePositions()
      .catch(() => {})
      .finally(() => { _statusSyncAt = Date.now(); _statusSyncP = null; });
    return _statusSyncP;
  }

  // v21.25.2 PHASE 0 WALLET HONESTY: audit detail bhi wahi actual live
  // equity use kare jo status/entry sizing use karte hain. Creds na hon
  // to null → phase0Audit configured wallet par fallback karta hai.
  async function resolveMtfAuditWalletINR(cfg) {
    if (!loadCredsForOrder()) return null;
    try {
      const liveCtx = await mtfAutoLiveCtx(cfg);
      const w = Number(liveCtx?.walletEquityINR);
      return w > 0 ? w : null;
    } catch {
      return null;
    }
  }

  // v21.24.0 PHASE 0 — full canonical audit (closed outcomes + stop integrity
  // + duplicate/manual-exit/reconciliation checks). `?fresh=1` bypasses the
  // 30s cache; normal dashboard polls ride the cache via /status.phase0.
  app.get('/api/ai/mtf-auto/phase0', async (req, res) => {
    try {
      const fresh = String(req.query?.fresh || '') === '1';
      const cfg = loadMtfAutoConfig();
      const walletINR = await resolveMtfAuditWalletINR(cfg);
      res.set('Cache-Control', 'no-store');
      res.json(buildPhase0Audit({ fresh, walletINR }));
    } catch (e) {
      jsonError(res, 500, 'phase0 audit failed', e);
    }
  });

  app.get('/api/ai/mtf-auto/status', async (_req, res) => {
    try {
      const cfg = loadMtfAutoConfig();
      const hasCreds = Boolean(loadCredsForOrder());
      let liveWalletINR = null;
      if (hasCreds) {
        try {
          const liveCtx = await mtfAutoLiveCtx(cfg);
          // v21.24.0 PHASE 0 WALLET HONESTY: caps/95-deployment display ke
          // liye actual live wallet — entry sizing pehle se isi ko use karta hai.
          if (Number(liveCtx?.walletEquityINR) > 0) liveWalletINR = Number(liveCtx.walletEquityINR);
          await syncLiveThrottled(liveCtx);  // A2: throttled instead of direct
        } catch { /* non-fatal */ }
      }
      const combinedQuotes = { ...(getLatestQuotes().data || {}) };
      // v21.23.8: EQUITY SIM (GLOBALFUTURES) qualified quotes overlay — deep
      // monitor status EQUITY SIM trades ka live USDC price inhi se dikhata hai.
      Object.assign(combinedQuotes, await mtfGlobalQuoteOverlay());
      try {
        const usdtMap = await mtfUsdtQuoteMap();
        if (usdtMap instanceof Map) {
          for (const [sym, px] of usdtMap) {
            if (Number(px) > 0) {
              combinedQuotes[sym] = px;
              combinedQuotes[`FUTURES|${sym}`] = px;
              combinedQuotes[`CRYPTO|${sym}`] = px;
            }
          }
        }
      } catch { /* non-fatal */ }
      const st = mtfAutoStatus(combinedQuotes, { walletINR: liveWalletINR });
      const routeCfg = loadMtfAutoConfig();
      const ready = mtfAutoReadiness(routeCfg);
      res.set('Cache-Control', 'no-store');
      res.json({
        ...st,
        // v21.24.0 PHASE 0 — lightweight audit summary (30s cache; heavy
        // detail /api/ai/mtf-auto/phase0 se milta hai).
        // v21.25.2: actual live wallet pass — riskCaps/over-risk warning
        // status ke effectiveWalletINR se match karta hai.
        phase0: getPhase0Summary({ walletINR: liveWalletINR }),
        siteLiveActive: ready.siteLiveActive,
        siteLiveByDesk: ready.siteLiveByDesk,
        deskReady: ready.deskReady,
        deskArmable: ready.deskArmable,
        killSwitch: ready.killSwitch,
        coindcxConnected: ready.hasCreds,
        // v21.26.0: dedicated per-trade tick agent health + live states
        // (ARMED / MONITORING / TP1_SECURED / FLIPPED / PAUSED / IDLE).
        superAgent: autoTradeSuperAgentStatus(),
      });
    } catch (e) {
      jsonError(res, 500, 'mtf auto status failed', e);
    }
  });

  app.post('/api/ai/mtf-auto/config', (req, res) => {
    try {
      const body = { ...(req.body || {}) };
      // Switching MTF auto to paper must not inherit the legacy site-live
      // auto-sync flag. Before this, POST {executionMode:'paper'} with the
      // default autoSyncSiteLive:true still executed REAL orders on a live
      // site (the UI paper button already forces false). An explicit
      // autoSyncSiteLive in the same request is still honoured.
      if (body.executionMode === 'paper' && body.autoSyncSiteLive === undefined) {
        body.autoSyncSiteLive = false;
      }
      const cfg = updateMtfAutoConfig(body);
      // v21.20.0 + v21.22.0: When user activates LIVE mode on the MTF Dual Board,
      // sync live mode but keep legacy spot allowAuto=false so only the MTF single-trade engine executes
      if (cfg.executionMode === 'live' && loadCredsForOrder()) {
        try {
          const cur = loadConfig();
          if (cur.mode !== 'live' || cur.allowAuto) {
            updateConfig({ mode: 'live', liveConfirmPhrase: 'LIVE', allowAuto: false });
          }
        } catch { /* best-effort */ }
      }
      const ready = mtfAutoReadiness(cfg);
      res.json({
        ok: true,
        config: cfg,
        coindcxConnected: ready.hasCreds,
        siteLiveActive: ready.siteLiveActive,
        siteLiveByDesk: ready.siteLiveByDesk,
        deskReady: ready.deskReady,
        deskArmable: ready.deskArmable,
        killSwitch: ready.killSwitch,
      });
    } catch (e) {
      jsonError(res, 400, 'mtf auto config failed', e);
    }
  });

  app.post('/api/ai/mtf-auto/toggle', (req, res) => {
    try {
      const enabled = Boolean((req.body || {}).enabled);
      setMtfAutoEnabled(enabled);
      const ready = mtfAutoReadiness(loadMtfAutoConfig());
      res.json({
        ...mtfAutoStatus(),
        coindcxConnected: ready.hasCreds,
        siteLiveActive: ready.siteLiveActive,
        siteLiveByDesk: ready.siteLiveByDesk,
        deskReady: ready.deskReady,
        deskArmable: ready.deskArmable,
        killSwitch: ready.killSwitch,
      });
    } catch (e) {
      jsonError(res, 400, 'mtf auto toggle failed', e);
    }
  });

  /** Dry-run: kaun abhi QUALIFY karta hai (+ blocked rows ke exact reasons).
   *  Kuch bhi open nahi karta — trust ke liye pehle ye dekho. */
  app.get('/api/ai/mtf-auto/preview', async (req, res) => {
    try {
      const cfg = loadMtfAutoConfig();
      const deps = depsForSignals();
      const boards = {};
      for (const market of ['INDIA', 'CRYPTO']) {
        const on = market === 'INDIA' ? cfg.desks.india : cfg.desks.crypto;
        if (!on) continue;
        if (market === 'INDIA' && !isNseOpen()) continue;
        const boardSigs = await boardSignalsForDesk(market, deps);
        boards[market] = await getDualMtfBoard({
          market, mode: cfg.mode, holdMin: cfg.holdMin, minScore: cfg.minScore,
          boardSigs, fx: await mtfLiveFx(),
        });
      }
      const status = mtfAutoStatus();
      const lastEntryAt = Object.fromEntries((status.book || []).filter(b => b.openedAt).map(b => [b.symbol, b.openedAt]));
      const openSymbols = new Set((getPaperSummaryExec()?.open || []).map(t => String(t.symbol || '').toUpperCase()));
      const preview = Object.fromEntries(Object.entries(boards).map(([mkt, b]) => [mkt, {
        counts: b?.counts || null,
        picks: dualAutoCandidates([...(b?.rows || []), ...(b?.metalsRows || []), ...(b?.equitySimRows || [])], cfg, { openSymbols, lastEntryAt, now: Date.now() })
          .slice(0, 12)
          .map(r => ({
            symbol: r.symbol, side: r.side, superScore: r.superScore, tier: r.tier,
            entry: r.plan?.entry ?? null, stopLoss: r.plan?.stopLoss ?? null, t1: r.plan?.t1 ?? null, t2: r.plan?.t2 ?? null,
            tfFit: r.tfFit, holdMin: r.holdMin, eligible: r.autoPickBlockers.length === 0, blockers: r.autoPickBlockers,
          })),
      }]));
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, enabled: cfg.enabled, mode: cfg.mode, minScore: cfg.minScore, preview });
    } catch (e) {
      jsonError(res, 500, 'mtf auto preview failed', e);
    }
  });

  /** Manual tick (user "abhi ek baar chalao") — same gates as the loop. */
  app.post('/api/ai/mtf-auto/run', async (req, res) => {
    try {
      const cfg = loadMtfAutoConfig();
      const killSwitch = (() => { try { return !!loadConfig()?.killSwitch; } catch { return false; } })();
      const deps = depsForSignals();
      const boards = {};
      const fxLive = await mtfLiveFx();
      const hasOpenIndia = mtfAutoOpenCount('INDIA') > 0;
      for (const market of ['INDIA', 'CRYPTO']) {
        const on = market === 'INDIA' ? cfg.desks.india : cfg.desks.crypto;
        if (!on) continue;
        if (market === 'INDIA' && !isNseOpen() && !hasOpenIndia) continue;
        // v21.25.3 [BOARD-SIGNAL COMPLETENESS]: /run uses the SAME merged
        // FUTURES + METALS + GLOBALFUTURES signals as the UI/60s/15s engine
        // paths — manual run cannot disagree with the board the user sees.
        const boardSigs = await boardSignalsForDesk(market, deps);
        boards[market] = await getDualMtfBoard({ market, mode: cfg.mode, holdMin: cfg.holdMin, minScore: cfg.minScore, boardSigs, fx: fxLive });
      }
      const liveCtx = await mtfAutoLiveCtx(cfg);
      const out = await mtfAutoTick({
        boards,
        buildDualRow,
        paper: { openPaperTrade: openPaperTradeExec, closePaperTrade: closePaperTradeExec, voidPaperTrade: voidPaperTradeExec, getPaperSummary: getPaperSummaryExec, updatePaperTradeT1ClosePct, updatePaperTradeTarget2 },
        quotes: { ...getLatestQuotes().data, ...(await mtfGlobalQuoteOverlay()) },
        killSwitch,
        fx: fxLive,
        usdtQuotes: cfg.desks.crypto ? await mtfUsdtQuoteMap() : null,
        siteLiveActive: liveCtx.siteLiveActive,
        siteLiveByDesk: liveCtx.siteLiveByDesk,
        walletEquityINR: liveCtx.walletEquityINR,
        syncLivePositions: liveCtx.syncLivePositions,
        liveExecute: liveCtx.liveExecute,
        liveUpdateSl: liveCtx.liveUpdateSl,
        liveClose: liveCtx.liveClose,
        notify: sendTelegram,
      });
      // New AUTO entries arm their dedicated tick agent in this same turn.
      refreshAutoTradeSuperAgent();
      res.json({ ok: true, tick: out });
    } catch (e) {
      jsonError(res, 500, 'mtf auto run failed', e);
    }
  });

  // ---------------- v20.7.5: 15s signal recheck (live watchlist) ----------------
  // The STRONG/ACTION signals' live re-validation state — polled by the
  // frontend panel at the SAME 15s cadence the loop runs. no-store: this
  // IS the freshness surface.
  app.get('/api/ai/signal-recheck', (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(signalRecheckStatus());
    } catch (e) {
      jsonError(res, 500, 'signal recheck status failed', e);
    }
  });

  // ---------------- India options desk ----------------
  // v9.4: combined NIFTY + SENSEX option SIGNAL CARDS (one request,
  // 30s cached) — the "Nifty50 17Sep 23400 CE · Target · Entry (Buy)
  // · Stop Loss" strip on the Options Desk.
  app.get('/api/ai/option-signals', async (_req, res) => {
    try {
      // v21.7.0 (Issue-1): explicit no-store — option-signals sirf fresh
      // serve honge (options-scan/status ke saath parity; pehle Express
      // default Etag hi tha).
      res.set('Cache-Control', 'no-store');
      const view = await getOptionSignalsView(depsForSignals());
      res.json(view);
    } catch (e) {
      jsonError(res, 500, 'option signals failed', e);
    }
  });

  // ---------------- v21.0.2 OPTIONS AUTO-ENTRY (paper) ----------------
  // Status + toggle for the NIFTY/SENSEX options auto-entry loop
  // (optionsAutoEntry.js — default OFF, UI se on karte hain).
  app.get('/api/ai/options-auto/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(optionsAutoStatus());
  });
  app.post('/api/ai/options-auto/toggle', (req, res) => {
    const enabled = Boolean((req.body || {}).enabled);
    const st = setOptionsAutoEnabled(enabled);
    res.json(st);
  });

  // ---------------- v10.17: OPTIONS SCANNER ----------------
  // Whole-F&O chain scan in one view: 3 indices + top stock-option
  // underlyings (from the full-universe discovery), each with a
  // deterministic direction read, GEX pin/flip zone and expected-move
  // band, ranked by the transparent scan score. 90s cached.
  app.get('/api/ai/options-scan', async (req, res) => {
    try {
      const force = req.query.fresh === '1';
      res.set('Cache-Control', 'no-store');
      res.json(await scanOptionsUniverse({ force }));
    } catch (e) {
      jsonError(res, 500, 'options scan failed', e);
    }
  });

  app.get('/api/ai/options', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store'); // v21.7.0: fresh-only parity
      const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
      const desk = await getOptionsDesk(symbol);
      if (!desk?.ok) return res.status(502).json(desk);
      // v21.7.0 (Issue-1): liveSpot pass — deep index-plan LIVE desk spot
      // par anchor (F&O cards entry/exit accuracy fix).
      const deep = await getDeepSignal(symbol, 'INDIA', depsForSignals(), { optionsCtx: desk.optionsCtx, liveSpot: desk.spot }).catch(() => null);
      const consensus = deep?.ok ? {
        side: deep.signal.side, confidence: deep.signal.confidence,
        agreement: deep.signal.agreement, grade: deep.signal.grade,
      } : { side: 'FLAT', confidence: 0, agreement: 0, grade: 'NEUTRAL' };
      res.json({
        ...desk,
        consensus,
        strategies: buildStrategies(desk, consensus),
      });
    } catch (e) {
      jsonError(res, 500, 'options desk failed', e);
    }
  });

  // ---------------- trading state / config ----------------
  app.get('/api/ai/trading/state', (_req, res) => {
    try {
      res.set('Cache-Control', 'no-cache');
      res.json({ ok: true, ...getRiskState() });
    } catch (e) { jsonError(res, 500, 'state failed', e); }
  });

  app.post('/api/ai/trading/config', (req, res) => {
    try {
      const cfg = updateConfig(req.body || {});
      res.json({ ok: true, config: cfg });
    } catch (e) {
      const status = e?.status || 400;
      return res.status(status).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/ai/trading/kill-switch', (req, res) => {
    try {
      const enabled = !!(req.body || {}).enabled;
      const cfg = updateConfig({ killSwitch: enabled });
      if (enabled) {
        cancelAllExchangeOrders().catch(() => { /* best-effort */ });
      }
      res.json({ ok: true, config: cfg });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------- THE EXECUTION GAUNTLET (crypto) ----------------
  app.post('/api/ai/execute', async (req, res) => {
    try {
      const { symbol, side, mode, qtyINR, leverage } = req.body || {};
      if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
      const result = await executeSignal({
        symbol: String(symbol).toUpperCase(),
        side: side ? String(side).toUpperCase() : undefined,
        // v6.11: notify = alert-only gauntlet (telegram + journal audit)
        mode: mode === 'live' ? 'live' : mode === 'notify' ? 'notify' : 'paper',
        qtyINR: qtyINR != null ? Number(qtyINR) : undefined,
        // v6.6: leverage is CLAMPED server-side to config.cryptoLeverage —
        // a client payload can never widen the ceiling
        leverage: leverage != null ? Number(leverage) : undefined,
        getFreshSignal: (pair, o) => getFreshSignalForExec(pair, depsForSignals(), o),
        wantAuto: false,
        source: 'manual',
        sendTelegram, // v6.11: notify-mode alert sender
      });
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------- THE EXECUTION GAUNTLET (GLOBAL FUTURES, v6.8) ----------------
  app.post('/api/ai/futures/execute', async (req, res) => {
    try {
      const { symbol, side, mode, qtyINR, marginUSDT, leverage } = req.body || {};
      if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
      const result = await executeFuturesSignal({
        symbol: String(symbol).toUpperCase().replace(/^B-/, '').replace(/_USDT$/, ''),
        side: side ? String(side).toUpperCase() : undefined,
        mode: mode === 'live' ? 'live' : mode === 'notify' ? 'notify' : 'paper',
        qtyINR: qtyINR != null ? Number(qtyINR) : undefined,
        marginUSDT: marginUSDT != null ? Number(marginUSDT) : undefined,
        leverage: leverage != null ? Number(leverage) : undefined,
        getFreshSignal: (pair, o) => getFreshFuturesSignalForExec(pair, depsForSignals(), o),
        wantAuto: false,
        source: 'manual',
        sendTelegram, // v6.11: notify-mode alert sender
      });
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------- v21.3.0 (Issue-4) ONE-CLICK LIVE PRE-FLIGHT ----------------
  // READ-ONLY dry-run of the exact gauntlet + would-be ticket: kill/exec
  // kill/go-live/strategy/mode/connection/signal gates + sizing preview
  // (qty @ instrument precision, margin, leverage sanity, liquidation,
  // native SL+TP pair). NO order, NO journal entry — the frontend's
  // ⚡ EXECUTE LIVE modal isi pe ban'ta hai (hold-to-confirm flow).
  app.post('/api/ai/futures/execute/precheck', async (req, res) => {
    try {
      const { symbol, side, marginUSDT, leverage } = req.body || {};
      if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
      const { futuresExecutePrecheck } = await import('./futures.js');
      const out = await futuresExecutePrecheck({
        symbol: String(symbol).toUpperCase().replace(/^B-/, '').replace(/_USDT$/, ''),
        side: side ? String(side).toUpperCase() : undefined,
        marginUSDT: marginUSDT != null ? Number(marginUSDT) : undefined,
        leverage: leverage != null ? Number(leverage) : undefined,
        getFreshSignal: (pair, o) => getFreshFuturesSignalForExec(pair, depsForSignals(), o),
      });
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------- GLOBAL EQUITY FUTURES desk (v10.4 — AAPL/GOOGL/NVDA/…/SPACEX SIM) ----------------
  app.post('/api/ai/global/execute', async (req, res) => {
    try {
      const { symbol, side, mode, qtyINR, marginUSDT, leverage } = req.body || {};
      if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
      const result = await executeGlobalSignal({
        symbol: String(symbol).toUpperCase().replace(/-USD$/, ''),
        side: side ? String(side).toUpperCase() : undefined,
        mode: mode === 'live' ? 'live' : mode === 'notify' ? 'notify' : 'paper', // 'live' passes through — gate 0 rejects it honestly (SIM desk)
        qtyINR: qtyINR != null ? Number(qtyINR) : undefined,
        marginUSDT: marginUSDT != null ? Number(marginUSDT) : undefined,
        leverage: leverage != null ? Number(leverage) : undefined,
        getFreshSignal: (pair, o) => getFreshGlobalSignalForExec(pair, depsForSignals(), o),
        wantAuto: false,
        source: 'manual',
        sendTelegram,
      });
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get('/api/ai/global/markets', async (_req, res) => {
    try {
      const out = await globalFuturesMarketsView();
      if (!out?.ok) return res.status(502).json(out);
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'global futures markets failed', e);
    }
  });

  // ---------------- CoinDCX WALLET (spot + futures, v6.8) ----------------
  app.get('/api/ai/wallet', async (_req, res) => {
    try {
      res.json(await walletSnapshot());
    } catch (e) {
      const status = e?.status || 502;
      res.status(status).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // v20.6.3: MANUAL FUTURES WALLET RECONNECT — POST /api/ai/wallet/reconnect
  // clears the futures wallet transport ladder + cooldown + scope probe,
  // then re-fetches the wallet snapshot. Designed for the live user case
  // where the futures wallet stopped reading after a transient 401 / WAF
  // block armed the cooldown (the 5-min cooldown + the 10-probe escape-
  // hatch could leave the wallet blank for ~10 minutes; this endpoint
  // forces an immediate fresh ladder sweep so the user gets a working
  // wallet on demand). Body: { force?: true }. Auth-gated by requireAuth.
  app.post('/api/ai/wallet/reconnect', async (req, res) => {
    try {
      const force = req.body && (req.body.force === true || req.body.force === 'true');
      // dynamic import to avoid circular dep (futures.js statically imports coindcx.js)
      const fut = await import('./futures.js');
      if (typeof fut.resetWalletTransportForReconnect === 'function') {
        fut.resetWalletTransportForReconnect();
      }
      // if force, also clear the scope probe (the cached "no_scope" / "ok" verdict)
      // — see futures.js::probeFuturesKeyScope + lastFuturesKeyScope()
      // (the next walletSnapshot call will re-probe if needed)
      // v20.8.5: { force: true } bypass the 10s snapshot mini-cache — the
      // post-reset verify hamesha FRESH round-trip ho (cached pre-reset
      // error verify ko jhootha pass/fail kar sakta tha).
      const snap = await walletSnapshot({ force: true });
      res.json({
        ok: true,
        reset: true,
        forced: !!force,
        snapshot: snap,
        note: force
          ? 'Futures wallet transport fully reset (ladder + cooldown + scope). Next /api/ai/wallet poll will do a fresh 7-rung sweep.'
          : 'Futures wallet transport reset (ladder + cooldown). Next /api/ai/wallet poll will do a fresh sweep.',
      });
    } catch (e) {
      const status = e?.status || 502;
      res.status(status).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // v20.7.1: FUTURES WALLET DIAGNOSTIC — GET /api/ai/wallet/diagnose
  app.get('/api/ai/wallet/diagnose', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const cd = await import('../mcp/coindcx.js');
      const creds = cd.coindcxEnvCreds ? cd.coindcxEnvCreds() : null;
      const connected = cd.coindcxConnected();
      if (!connected || !creds) {
        return res.json({ ok: false, error: 'CoinDCX not connected', connected });
      }
      const WALLETS_PATH = '/exchange/v1/derivatives/futures/wallets';
      const trace = [];
      const t0 = Date.now();
      try {
        const r = await cd.coindcxPrivateGET(WALLETS_PATH, creds.apiKey, creds.secret, {}, {
          unit: 'ms', tsType: 'num', mode: 'body',
        });
        trace.push({ rung: 'GET-body/ms/num', ok: true, responseLength: Array.isArray(r) ? r.length : 0, sample: Array.isArray(r) && r.length > 0 ? r[0] : null });
      } catch (e) {
        trace.push({ rung: 'GET-body/ms/num', ok: false, error: String(e?.message || e).slice(0, 300), status: e?.status });
      }
      // v20.7.3 FIX: mask the tail only — the old first-4+last-4 exposure
      // handed 8 chars of live key material to the client (the leading 4
      // add nothing diagnostic; matches secrets.js masking convention).
      res.json({ ok: true, connected, walletPath: WALLETS_PATH, apiKeyPrefix: creds.apiKey ? `…${creds.apiKey.slice(-4)}` : '—', elapsedMs: Date.now() - t0, trace, note: '401=auth/scope; 403=WAF; 404=endpoint moved; 5xx=server; ok:true+responseLength=0=no USDT balance' });
    } catch (e) { jsonError(res, 500, 'wallet diagnose failed', e); }
  });

  // ============================================================
  // v20.7 EXECUTION STACK routes — Phase 2/4/5 control surface
  // ------------------------------------------------------------
  //   GET  /api/exec/status       — exec mode + kill level + leader + heartbeat
  //   POST /api/exec/kill         — { level: 0|1|2|3, reason } → setKill
  //   POST /api/exec/enter        — protection-first entry (signal + plan body)
  //   GET  /api/exec/positions    — port.getPositions() (exchange truth)
  //   GET  /api/exec/equity       — port.getEquity()
  // All auth-gated by the global requireAuth middleware at index.js:403.
  // The execution port is the v20.7 module (paper default — safe).
  // ============================================================
  app.get('/api/exec/status', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const { killLevel, killReason, isKilled, canEnterNew, isLeader, leaderNode } = await import('../exec/reconciler.js');
      const { ramState } = await import('../ai/ramGovernor.js');
      res.json({
        ok: true,
        execMode: process.env.EXEC_MODE || 'paper',
        execNode: process.env.SMARTAI_EXEC_NODE || 'laptop',
        leader: { isLeader: isLeader(), node: leaderNode() },
        kill: { level: killLevel(), reason: killReason(), isKilled: isKilled(), canEnterNew: canEnterNew() },
        ram: ramState(),
      });
    } catch (e) { jsonError(res, 500, 'exec status failed', e); }
  });

  app.post('/api/exec/kill', async (req, res) => {
    try {
      const { setKill } = await import('../exec/reconciler.js');
      // v21.1.1 [audit B4]: pehle missing/non-numeric level NaN→0 ho jaata tha
      // — panic path pe ek malformed request ({}, {level:"halt"}) ACTIVE kill
      // CLEAR kar deta thi. Ab explicit integer 0-3 hi accept hota hai; aur
      // level 0 (disarm) ke liye confirm phrase chahiye (LIVE-arming jaisa
      // hi two-step) taaki accidental disarm ho hi na sake.
      const raw = (req.body || {}).level;
      const level = Number(raw);
      if (!Number.isInteger(level) || level < 0 || level > 3) {
        return res.status(400).json({ ok: false, error: { code: 'BAD_LEVEL', message: 'level must be an explicit integer 0-3' } });
      }
      const reason = String((req.body || {}).reason || 'manual UI button');
      if (level === 0) {
        const confirm = String((req.body || {}).confirm || '').trim().toUpperCase();
        if (confirm !== 'CLEAR-KILL') {
          return res.status(400).json({ ok: false, error: { code: 'CONFIRM_REQUIRED', message: 'Kill disarm karne ke liye body me "confirm":"CLEAR-KILL" bhejo (accidental protect). Level 0 hi confirm maangta hai; 1-3 seedha set hota hai.' } });
        }
      }
      const r = setKill(level, level === 0 ? `${reason} (confirmed CLEAR-KILL)` : reason);
      res.json({ ok: true, ...r });
    } catch (e) { jsonError(res, 500, 'exec kill failed', e); }
  });

  app.get('/api/exec/positions', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      // read the live port from globalThis (set at index.js boot)
      let port = globalThis.__execPort || null;
      if (!port) {
        const { PaperPort } = await import('../exec/port.js');
        port = new PaperPort({ startingEquityUSDT: 0 });
      }
      const positions = await port.getPositions();
      res.json({ ok: true, positions });
    } catch (e) { jsonError(res, 500, 'exec positions failed', e); }
  });

  app.get('/api/exec/equity', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      let port = globalThis.__execPort || null;
      if (!port) {
        const { PaperPort } = await import('../exec/port.js');
        port = new PaperPort({ startingEquityUSDT: 0 });
      }
      const equity = await port.getEquity();
      res.json({ ok: true, equity });
    } catch (e) { jsonError(res, 500, 'exec equity failed', e); }
  });

  // ------------------------------------------------------------
  // v20.7.12 [H2-2]: POST /api/exec/enter — the DOCUMENTED-but-MISSING
  // protection-first entry route. Pehle sirf comment me promise tha
  // (routes.js:841 ka doc-block) jabki PositionManager ka pura ladder
  // (protection-first + T1/T2/trail + reversal) unwired dead-code tha.
  // Ab real: signal+plan body → canEnterNew (kill-switch + leader lease)
  // → PM.protectionFirstEntry (sizing → open → fill-poll → leverage check
  // → native SL set + verify → flatten-on-fail) → journal me auditable
  // ORDER entry. Browser mode REFUSED (setProtection Phase-6 pending —
  // wahan entry SAPTA/gauntlet se hi). Exit-ladder tick index.js me
  // 15m cadence pe chalta hai (PM state khali ho to no-op).
  // ------------------------------------------------------------
  app.post('/api/exec/enter', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const port = globalThis.__execPort || null;
      const pm = globalThis.__positionManager || null;
      if (!port || !pm) return jsonError(res, 503, 'execution stack not armed (boot me arm nahi hui — server logs dekho)');
      if (port.mode === 'browser') {
        return jsonError(res, 400, 'EXEC_MODE=browser pe protection-first entry supported nahi hai (Phase 6 UI-SL pending) — api ya paper mode use karo, ya browser desk se SAPTA chalao');
      }
      const { signal, plan } = req.body || {};
      const symbol = String(signal?.symbol || '').trim().toUpperCase();
      const side = String(signal?.side || '').trim().toUpperCase();
      if (!symbol || !/^[A-Z0-9._-]{1,20}$/.test(symbol)) return jsonError(res, 400, 'signal.symbol required (charset [A-Z0-9._-], ≤20)');
      if (side !== 'LONG' && side !== 'SHORT') return jsonError(res, 400, 'signal.side must be LONG or SHORT');
      if (!(Number(plan?.stopLoss) > 0)) return jsonError(res, 400, 'plan.stopLoss required (>0) — protection-first sequence SL ke bina nahi chal sakta');
      // v20.9.1 [H2]: PAIR NORMALIZATION — route sirf symbol/side validate
      // karta tha aur signal AS-IS forward karta tha; caller jab pair nahi
      // deta (documented contract) to port.open({pair:'BTC'}) jata tha:
      // EXEC_MODE=api me CoinDCX non-B-..._USDT pair reject karta hai, aur
      // paper me position 'BTC' key pe banti thi jabki 15m ladder driver
      // 'B-BTC_USDT' keys se marks deta hai → SL/T1/T2/trail legs KABHI
      // fire nahi hote (sirf 8-candle time-stop). Journal bhi 'B-…_USDT'
      // hi likhta tha — ab wahi pair order tak guarantee hota hai. Caller
      // diya hua pair agar B-{SYM}_USDT form me NAHI hai to honest 400
      // (koi silent remap nahi — galat venue pe order ja sake).
      {
        const expected = `B-${symbol}_USDT`;
        const given = String(signal?.pair || '').trim().toUpperCase();
        if (given && given !== expected) {
          return jsonError(res, 400, `signal.pair '${given}' is not the CoinDCX futures form for symbol ${symbol} (expected '${expected}') — pair hata do ya correct form bhejo`);
        }
        signal.pair = expected;
      }
      const { canEnterNew, killLevel, killReason } = await import('../exec/reconciler.js');
      if (!canEnterNew()) {
        return res.status(423).json({ ok: false, error: `entries blocked — kill L${killLevel()} (${killReason() || 'manual'}) ya non-leader node` });
      }
      // v20.9.4 FIX (H3): JOURNAL RISK CAPS — pehle ye route sirf kill/leader
      // check karta tha; executeFuturesSignal/executeSignal/openReversalLeg
      // teeno ke paas gauntlet hai (daily trades/loss, one-per-pair,
      // max-open) par exec/enter PM ko seedha call karta tha → ek
      // authenticated caller (a) daily caps ke paar unlimited entries,
      // (b) same pair pe already position ho to naya limit order exchange
      // pe NET ho jaata (naya row nahi banta) → fill-poll kuch nahi dhaundta
      // → 180s baad "cancel" honest stub hai → DOUBLE REAL EXPOSURE bina
      // journal row ke. Ab wahi chaaron caps yahin enforce hote hain
      // (protectionFirstEntry se PEHLE, lock ke andar fresh read).
      const capErr = await withJournalLock(() => {
        const j = loadJournal();
        const capsCfg = (() => { try { return loadConfig(); } catch { return {}; } })();
        const stats = dailyStats(j);
        const pair = `B-${symbol}_USDT`;
        if (Number(stats.tradesCount) >= (Number(capsCfg.dailyMaxTrades) || 5)) {
          return `Daily trade cap (${capsCfg.dailyMaxTrades || 5}) hit — resets at IST midnight`;
        }
        if (Number(stats.realizedPnlINR) <= -(Number(capsCfg.dailyMaxLossINR) || 2000)) {
          return `Daily loss cap (₹${capsCfg.dailyMaxLossINR || 2000}) breached — trading paused for today`;
        }
        if ((j.positions || []).some(p => String(p.pair || '').toUpperCase() === pair && (p.status === 'OPEN' || p.status === 'UNKNOWN'))) {
          return `An open position already exists for ${pair} (one-per-pair rule — double exposure guard)`;
        }
        const openCount = (j.positions || []).filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN').length;
        if (openCount >= (Number(capsCfg.maxOpenPositions) || 5)) {
          return `Concentration guard: ${openCount} positions already open (max ${capsCfg.maxOpenPositions || 5})`;
        }
        return null;
      });
      if (capErr) {
        await withJournalLock(() => {
          const j = loadJournal();
          pushEntry(j, {
            kind: 'ORDER', day: todayIST(), pair: `B-${symbol}_USDT`, symbol: `B-${symbol}_USDT`, market: 'FUTURES', side,
            mode: port.mode === 'api' ? 'live' : 'paper', source: 'exec-enter',
            status: 'REJECTED', reason: `[risk-gate] ${capErr}`,
          });
          saveJournal(j);
        });
        return res.status(429).json({ ok: false, error: capErr });
      }
      const r = await pm.protectionFirstEntry({ signal: { ...signal, symbol, side }, plan });
      // journal the attempt (auditable, cap-aware) — same journal the
      // gauntlet writes to, same lock discipline
      await withJournalLock(() => {
        const j = loadJournal();
        pushEntry(j, {
          kind: 'ORDER', day: todayIST(), pair: `B-${symbol}_USDT`, symbol: `B-${symbol}_USDT`, market: 'FUTURES', side,
          mode: port.mode === 'api' ? 'live' : 'paper', source: 'exec-enter',
          // v21.1.1 [audit B19]: stage-aware status — pehle har non-OK
          // result 'REJECTED' likha jaata tha, jabki protection-fail /
          // leverage-mismatch stages me order PLACE ho chuka hota (fill bhi
          // ho sakta hai) — post-mortem me "never attempted" dikhna jhoot
          // tha. fill-confirm = sach me unfilled; baaki = submitted hua tha.
          status: r.ok ? 'FILLED' : (r.stage === 'fill-confirm' ? 'FAILED' : 'SUBMITTED_UNKNOWN'),
          reason: r.ok
            ? `PM protection-first entry OK (position ${r.positionId} · lev ${r.sizing?.leverage}x · qty ${r.sizing?.qty})`
            : `[${r.stage}] ${String(r.error || '').slice(0, 160)}`,
        });
        // v20.9.3 FIX (M): a REAL positions row too. Pehle sirf ORDER entry
        // likhi jaati thi — ek restart ke baad PM ka in-memory _state khali
        // aur j.positions me bhi kuch nahi tha → 15m ladder driver no-op,
        // watchFuturesPositions ko position dikhti hi nahi thi (T1/T2/trail/
        // time-stop sab gaye; sirf entry-armed native SL/TP bache). Ab row
        // likhte hain (execManaged marker ke saath) — PM boot pe hydrate
        // karta hai (index.js), aur watcher PM-armed hote hue isse skip
        // karta hai (double-ladder nahi).
        if (r.ok && r.positionId) {
          const entryPx = Number(r.fill?.price) || Number(plan?.entry) || null;
          const qty = Number(r.fill?.qty) || Number(r.sizing?.qty) || null;
          j.positions.push({
            id: String(r.positionId), pair: `B-${symbol}_USDT`, symbol, market: 'FUTURES', side,
            mode: port.mode === 'api' ? 'live' : 'paper', source: 'exec-enter', execManaged: true,
            qty, entryPrice: entryPx,
            leverage: Number(r.fill?.leverage) || Number(r.sizing?.leverage) || null,
            sl: Number(plan?.stopLoss) > 0 ? Number(plan.stopLoss) : null,
            tp: Number(plan?.target1) > 0 ? Number(plan.target1) : null,
            tp2: Number(plan?.target2) > 0 ? Number(plan.target2) : null,
            initialRisk: entryPx != null ? Math.round(Math.abs(entryPx - Number(plan?.stopLoss || entryPx)) * 10000) / 10000 : null,
            peakPrice: entryPx,
            signal: { grade: signal?.grade, confidence: signal?.confidence, agreement: signal?.agreement },
            openedAt: Date.now(), status: 'OPEN',
          });
        }
        saveJournal(j);
      });
      res.json(r);
    } catch (e) { jsonError(res, 500, 'exec enter failed', e); }
  });

  // ---------------- GLOBAL FUTURES markets view (v6.8) ----------------
  app.get('/api/ai/futures/markets', async (_req, res) => {
    try {
      const out = await futuresMarketsView();
      if (!out?.ok) return res.status(502).json(out);
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'futures markets failed', e);
    }
  });

  // ---------------- SUPERINTELLIGENCE AGENT (v6.8) ----------------
  app.get('/api/ai/agent', async (_req, res) => {
    try {
      res.json(await agentStatus(depsForSignals()));
    } catch (e) {
      jsonError(res, 500, 'agent status failed', e);
    }
  });

  app.post('/api/ai/agent/start', async (req, res) => {
    try {
      const { mode, liveConfirmPhrase } = req.body || {};
      res.json(await agentStart({ mode, liveConfirmPhrase }));
    } catch (e) {
      const status = e?.status || 400;
      res.status(status).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/ai/agent/stop', (_req, res) => {
    try { res.json(agentStop({ reason: 'user (panel)' })); }
    catch (e) { return res.status(400).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post('/api/ai/agent/config', (req, res) => {
    try {
      // mode changes NEVER pass through this endpoint — start/stop own it
      const { mode: _mode, enabled: _enabled, ...patch } = req.body || {};
      const cfg = updateAgentConfig(patch);
      res.json({ ok: true, config: cfg });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------- PRO TRADER AUTO — SAPTA (v18.6) ----------------
  // Superintelligence Advance AI Pro Trader Auto: browser-driven auto
  // execution. Gates (user spec): AI score >= 75, confidence >= 65,
  // verified score >= 90 + SVA CONFIRM + finalCall === side. Trades are
  // placed INSIDE the user's logged-in CoinDCX/Dhan browser tabs via CDP;
  // exits wait for a CONFIRMED reversal (2 consecutive confirmations).
  app.get('/api/ai/protrader-auto', (_req, res) => {
    try { res.json(proTraderStatusView()); }
    catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.get('/api/ai/protrader-auto/stream', proTraderStreamHandler);

  app.post('/api/ai/protrader-auto/start', (req, res) => {
    try {
      const { mode, liveConfirmPhrase } = req.body || {};
      res.json(proTraderStart({ mode, liveConfirmPhrase }));
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/ai/protrader-auto/stop', (_req, res) => {
    try { res.json(proTraderStop()); }
    catch (e) { return res.status(400).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post('/api/ai/protrader-auto/config', (req, res) => {
    try {
      const { mode: _mode, enabled: _enabled, ...patch } = req.body || {}; // start/stop own these
      const cfg = updateProTraderConfig(patch);
      res.json({ ok: true, config: cfg });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/ai/protrader-auto/browser/test', async (_req, res) => {
    try { res.json(await proTraderBrowserTest()); }
    catch (e) { return res.status(502).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post('/api/ai/protrader-auto/dry-run', async (req, res) => {
    try { res.json(await proTraderTestRun(depsForSignals())); }
    catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  // ---------------- NSE SUPERINTELLIGENCE AGENT (v10.3) ----------------
  // The India desk's autonomous agent — same contract as /api/ai/agent/*
  // but scoped to market INDIA + source 'india-agent' (cross-agent
  // hygiene: the crypto agent's accounting can never see these trades).
  app.get('/api/india/agent', async (_req, res) => {
    try {
      res.json(await indiaAgentStatus(depsForSignals()));
    } catch (e) {
      jsonError(res, 500, 'india agent status failed', e);
    }
  });

  app.post('/api/india/agent/start', async (req, res) => {
    try {
      const { mode, liveConfirmPhrase } = req.body || {};
      res.json(await indiaAgentStart({ mode, liveConfirmPhrase }));
    } catch (e) {
      const status = e?.status || 400;
      res.status(status).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/india/agent/stop', (_req, res) => {
    try { res.json(indiaAgentStop({ reason: 'user (panel)' })); }
    catch (e) { return res.status(400).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post('/api/india/agent/config', (req, res) => {
    try {
      // mode changes NEVER pass through this endpoint — start/stop own it
      const { mode: _mode, enabled: _enabled, ...patch } = req.body || {};
      const cfg = updateIndiaAgentConfig(patch);
      res.json({ ok: true, config: cfg });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------- THE EXECUTION GAUNTLET (India, v6.5) ----------------
  app.post('/api/ai/india/execute', async (req, res) => {
    try {
      const { symbol, side, mode, qtyINR } = req.body || {};
      if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
      const result = await executeIndiaSignal({
        symbol: String(symbol).toUpperCase(),
        side: side ? String(side).toUpperCase() : undefined,
        mode: mode === 'live' ? 'live' : mode === 'notify' ? 'notify' : 'paper',
        qtyINR: qtyINR != null ? Number(qtyINR) : undefined,
        getFreshIndiaSignal: async (sym) => {
          const deep = await getDeepSignal(sym, 'INDIA', depsForSignals()).catch(() => null);
          return deep?.ok ? deep.signal : null;
        },
        source: 'manual',
        sendTelegram, // v6.11: notify-mode alert sender
      });
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------- v10.16 SECTION 2: MANUAL TRADE TRACKER ----------------
  // The user's OWN trades — recorded off any signal card with the full
  // originating snapshot frozen at entry, tracked live (5s LTP · 30s
  // conviction re-vote via the monitor), closable here or via Telegram
  // /manualclose. Instrument coverage: India equity + F&O options +
  // crypto spot/perps + global SIM.
  app.post('/api/manual-trade', async (req, res) => {
    try {
      const b = req.body || {};
      const out = recordManualTrade(b);
      if (!out.ok) return res.status(400).json(out);
      // confirmation push (best-effort) — the baseline is now frozen
      const vStamp = out.trade?.verify;
      sendTelegram(`📝 <b>MANUAL TRADE recorded</b>\n<b>${_tgEsc(out.trade.symbol)}</b> ${out.trade.side === 'BUY' ? 'LONG' : 'SHORT'} @ ${out.trade.entryPrice} · qty ${out.trade.qty}${out.trade.assetKind === 'OPTION' ? ` (${_tgEsc(out.trade.optType)} ${_tgEsc(out.trade.strike)} exp ${_tgEsc(out.trade.expiry)})` : ''}\n${out.trade.origin?.aiScore != null ? `Entry AI score: ${out.trade.origin.aiScore} · conviction tracking ON` : 'Conviction tracking ON'}${vStamp ? `\n🛡 <b>SVA verdict @ open: ${_tgEsc(vStamp.action)} — ${_tgEsc(vStamp.finalCall)} (${vStamp.score}/100)</b>${vStamp.action === 'FLIP' || vStamp.action === 'STAND_ASIDE' ? '\n⚠️ Verifier ne is entry ko reject kiya tha — small size / quick SL rakho.' : ''}` : ''}\n<i>Flip ho gaya to EXIT NOW push aa jayega — WHY ke saath.</i>`).catch(() => {});
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get('/api/manual-trades', async (req, res) => {
    try {
      const trades = listManualTrades(req.query.status ? { status: String(req.query.status).toUpperCase() } : {});
      const open = trades.filter(t => t.status === 'OPEN');
      // LTP sweep for the OPEN rows (tick store first — free; TV batch
      // for India fallback, BS re-price for options). One batched call,
      // not per-trade.
      // v18.6.4: TV batch ab LAZY — sirf un symbols ke liye jo tick store
      // me missing hain (5s poll pe har baar uncached TV scanner POST —
      // 12 scans/min — TV 429/ban risk tha). 30s micro-cache bhi.
      let indiaQuotes = null;
      const indiaSyms = open.filter(t => t.market === 'INDIA' && t.assetKind !== 'OPTION').map(t => t.symbol);
      if (indiaSyms.length > 0) {
        const missing = indiaSyms.filter((s) => !(_getTick(`IN_${s}`)?.price > 0));
        if (missing.length > 0) {
          const cachedBatch = _tvIndiaBatchCache.get('batch');
          if (cachedBatch && Date.now() - (cachedBatch.at || 0) < 30_000) {
            indiaQuotes = cachedBatch.rows;
          } else {
            const rows = await fetchTVIndiaBatch([...new Set(missing)]).catch(() => null);
            if (rows) { _tvIndiaBatchCache.set('batch', { at: Date.now(), rows }); indiaQuotes = rows; }
          }
        }
      }
      const fetchIndiaQuotes = indiaQuotes ? async () => indiaQuotes : null;
      // v18.6.4: option-spot micro-cache (10s) — per-poll per-trade Yahoo
      // chart calls (720/hr per open option trade) + sequential unbounded
      // loop vs client abort 25s = LIVE OFF flips. 10s TTL is plenty for
      // a BS re-price input.
      const _optSpot = new Map();
      const fetchIndexSpot = async (sym) => {
        const hit = _optSpot.get(sym);
        if (hit && Date.now() - hit.at < 10_000) return hit.q;
        const q = await fetchYahooQuotes([sym]).catch(() => ({}));
        const out = q?.[sym] || null;
        _optSpot.set(sym, { at: Date.now(), q: out });
        return out;
      };
      // v20.2: 84 → last-known-good rate (disk-backed, ~0 error vs ~5%)
      let usdInr = usdInrFallback();
      try { usdInr = (await fetchUsdInr()) || usdInrFallback(); } catch { /* default */ }
      const views = [];
      // v11.5: bound the on-demand deep re-votes — one slow/hung deep call
      // (upstream CoinDCX futures API / TradingView outage) must never drag
      // the whole tracker API into its own timeout ("tracker fetch fail").
      // Per-trade 10s cap + a shared 25s budget; once the budget is spent,
      // remaining trades go straight to the last-known conviction below.
      // v18.6.3 REALTIME NEVER STOPS: budget tightened 25s→12s (per-trade
      // 10s→8s) — the client's abort fires at 25s, and a route that
      // regularly lands 20-25s flipped the tracker badge to LIVE OFF on
      // slow upstream ticks. The monitor's own 30s conviction re-vote
      // (server-side, independent of any request) remains the source of
      // truth — this on-demand path is just a fresher-than-90s bonus.
      const DEEP_VOTE_TIMEOUT_MS = 8_000;
      const DEEP_VOTE_BUDGET_MS = 12_000;
      const deepDeadline = Date.now() + DEEP_VOTE_BUDGET_MS;
      for (const t of trades) {
        if (t.status !== 'OPEN') { views.push(t); continue; }
        const ltp = await ltpForManualTrade(t, { fetchIndiaQuotes, fetchIndexSpot });
        // v12.0: feed the MFE/MAE excursion (peak R / trough R) on every
        // tracker read — the exit-quality report card's raw data.
        if (ltp > 0) updateExcursion(t, ltp);
        // conviction: the monitor's fresh re-vote if present; on-demand
        // (cached deep path) when stale — the UI never shows a dead bar.
        let conviction = (Date.now() - (t.__conviction?.at || 0) < 90_000) ? t.__conviction : null;
        if (!conviction && Date.now() < deepDeadline) {
          try {
            // v11.5: raced against a 10s timer — the losing deep call keeps
            // running in the background and lands in its 30s cache either way
            // (self-healing for the NEXT request), but THIS response returns.
            const deep = await Promise.race([
              getDeepSignal(t.symbol, t.market === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : t.market, depsForSignals()),
              new Promise((_, rej) => {
                const tm = setTimeout(() => rej(new Error('deep re-vote timeout')), DEEP_VOTE_TIMEOUT_MS);
                if (typeof tm.unref === 'function') tm.unref();
              }),
            ]);
            if (deep?.ok && deep.signal) {
              const c = manualConvictionOf(t, deep.signal);
              // v18.6.4: side encoding = monitor ke jaisa (BUY/SELL via
              // sideOf semantics) — pehle route 'LONG'/'SHORT' stamp karta
              // tha aur __conviction alternating encodings se consumers
              // galat label karte the.
              conviction = { ...c, side: String(deep.signal.side || '').toUpperCase() === 'SHORT' ? 'SELL' : 'BUY', at: Date.now() };
              t.__conviction = conviction;
            }
          } catch { /* honest degrade — falls through to last-known below */ }
        }
        // v11.5 LAST-KNOWN FALLBACK: a transient upstream failure must not
        // blank a real conviction into "STALE — conviction data missing".
        // If this trade ever got a successful vote, keep showing it (age-
        // honest: `at` carries the vote's own stamp). UNKNOWN rows (never
        // voted) still degrade to the honest STALE banner.
        if (!conviction) conviction = lastKnownConvictionForView(t);
        views.push(manualTradeView(t, { ltp, usdInr, conviction }));
      }
      return res.json({
        ok: true,
        trades: views,
        // v12.9: the client-side realtime P&L recompute (SSE live ticks)
        // needs the SAME fx the server used — send it once per response.
        usdInr,
        monitor: manualMonitorStatus(),
        // v12.0: the tracker's own track-record — R win-rate, avg R,
        // capture efficiency, exit-quality counts.
        stats: manualStats(trades),
        counts: {
          open: open.length,
          closed: trades.filter(t => t.status === 'CLOSED').length,
          exitNow: views.filter(v => v.__view?.banner === 'EXIT_NOW').length,
        },
      });
    } catch (e) {
      return jsonError(res, 500, 'manual-trades failed', e);
    }
  });

  app.post('/api/manual-trade/:id/close', async (req, res) => {
    try {
      // v18.6.4: live usdInr thread karo (hardcoded 84 ka ~6% P&L error
      // at USDINR 89) + close apne aap fresh __ltp gate follow karta hai.
      let usdInr;
      try { usdInr = (await fetchUsdInr()) || undefined; } catch { /* default */ }
      const out = closeManualTrade(req.params.id, {
        exitPrice: req.body?.exitPrice != null ? Number(req.body.exitPrice) : undefined,
        reason: req.body?.reason,
        ...(usdInr != null ? { usdInr } : {}),
      });
      if (!out.ok) return res.status(400).json(out);
      sendTelegram(`✅ <b>MANUAL TRADE closed</b>\n<b>${_tgEsc(out.trade.symbol)}</b> ${out.trade.side === 'BUY' ? 'LONG' : 'SHORT'} @ ${out.trade.entryPrice} → ${out.trade.exitPrice}\nP&L: ${out.pnl.pnlPct >= 0 ? '+' : ''}${out.pnl.pnlPct}% (${out.pnl.currency === 'USDT' ? '$' + out.pnl.pnlUSDT : '₹' + out.pnl.pnlINR}) · reason: ${_tgEsc(out.trade.closeReason)}`).catch(() => {});
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------- positions / journal ----------------
  app.get('/api/ai/positions', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-cache');
      res.json({ ok: true, ...(await getPositionsWithPnl()) });
    }
    catch (e) { jsonError(res, 500, 'positions failed', e); }
  });

  // v10.5.3 REALTIME POSITIONS SSE — same auth as every /api/ai/* route
  // (EventSource appends ?session= per requireAuth). Push protocol:
  // `positions` (full snapshot on connect + structural changes) and
  // `tick` (per-position LTP/PnL deltas, price-driven). The REST GET
  // above stays as the fallback + reconciliation path.
  app.get('/api/ai/positions/stream', positionsStreamHandler);

  // ---------------- v12.8 REVERSAL RECOVERY AI (opt-in) ----------------
  // GET — config echo + the live cycle board (legs, net ₹, guards).
  // Prices/USDINR are the 20s/10m cached fetchers — cheap poll.
  // v12.9: MANUAL cycles ride the same board (the engine connection —
  // manual trades ACTIVATE a ₹ cycle at the thresholds).
  app.get('/api/ai/reversal', async (_req, res) => {
    try {
      const j = loadJournal();
      const [usdInr, prices] = await Promise.all([
        fetchUsdInr().catch(() => usdInrFallback()),
        fetchFuturesPrices().catch(() => []),
      ]);
      const byPair = new Map((Array.isArray(prices) ? prices : []).map(p => [p.pair, p.last]));
      const view = reversalCyclesView(j, { usdInr, byPair });
      const manualCycles = manualReversalCycles(listManualTrades(), { usdInr });
      res.json({
        ...view,
        manualCycles,
        activeCycles: view.activeCycles + manualCycles.filter(c => c.state !== 'ENDED').length,
      });
    } catch (e) { jsonError(res, 500, 'reversal view failed', e); }
  });

  // PUT — the opt-in knobs (same clamp table as the agent-config
  // route; force-refreshes the engine's 60s TTL cache so the next
  // watcher pass picks it up immediately).
  app.put('/api/ai/reversal/config', (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      for (const k of [
        'reversalEnabled', 'reversalLossCapINR', 'reversalProfitTargetINR', 'reversalMaxLegs',
        'reversalCooldownMin', 'reversalCycleStopINR', 'reversalReentryWindowMin',
        'reversalMinReentryConf', 'reversalRequireEnsembleConfirm', 'reversalAutoCut',
      ]) {
        if (body[k] != null) patch[k] = body[k];
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'koi reversal key nahi mili' });
      updateAgentConfig(patch);
      const cfg = loadReversalConfig(null, { force: true });
      if (patch.reversalEnabled != null) {
        sendTelegram([
          `🔄 <b>REVERSAL AI ${cfg.enabled ? 'ON' : 'OFF'}</b>`,
          cfg.enabled
            ? `Loss-cap ₹${cfg.lossCapINR} · Target ₹${cfg.profitTargetINR} · Max ${cfg.maxLegs} legs · Cycle-stop ₹${cfg.cycleStopINR}\nFutures desk ke OPEN positions ab ₹-cycle discipline me manage honge (loss-cap cut → flip → booking).`
            : 'Reversal cycles band — normal SL/TP/trailing discipline wapas.',
        ].join('\n')).catch(() => {});
      }
      res.json({ ok: true, config: cfg });
    } catch (e) { jsonError(res, 500, 'reversal config failed', e); }
  });


  app.post('/api/ai/positions/close', async (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      // v6.5: India positions close through the Dhan path (market order +
      // broker-SL cancel); crypto positions through the CoinDCX path.
      // v6.8: FUTURES positions close through the futures exit API.
      const j = loadJournal();
      const p = j.positions.find(x => x.id === id || x.exchangeOrderId === id);
      const out = p && p.market === 'INDIA'
        ? await closeIndiaPosition(String(id))
        : p && p.market === 'FUTURES'
          ? await closeFuturesPosition(String(id))
          : p && p.market === 'GLOBALFUTURES'
            ? await closeGlobalPosition(String(id)) // v10.4 SIM desk — live quote se close
            : await closePosition(String(id));
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // v10.17 — CLEAR CLOSED POSITIONS (the console's 🧹 CLEAR CLOSED
  // button). Purges CLOSED rows from the journal (ledger keeps the
  // permanent audit trail; a HOUSEKEEP entry stamps the sweep). Only
  // CLOSED rows are removed — OPEN/UNKNOWN untouched, no-live-effects.
  app.post('/api/ai/positions/clear-closed', async (_req, res) => {
    try {
      const out = await clearClosedPositions();
      return res.json(out);
    } catch (e) {
      return jsonError(res, 500, 'clear-closed failed', e);
    }
  });

  // ---------------- exchange orders (CoinDCX) ----------------
  app.get('/api/ai/orders', async (_req, res) => {
    try { res.json(await listExchangeOrders(['open', 'partially_filled'])); }
    catch (e) { jsonError(res, 500, 'orders failed', e); }
  });

  app.post('/api/ai/orders/cancel', async (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      res.json(await cancelExchangeOrder(String(id)));
    } catch (e) { jsonError(res, 500, 'cancel failed', e); }
  });

  app.post('/api/ai/orders/cancel-all', async (_req, res) => {
    try { res.json(await cancelAllExchangeOrders()); }
    catch (e) { jsonError(res, 500, 'cancel-all failed', e); }
  });

  // ---------------- backtest (v6.5 + v6.7 learned gates) ----------------
  app.get('/api/ai/backtest', async (req, res) => {
    try {
      const market = String(req.query.market || 'CRYPTO').toUpperCase();
      // v10.13 (deep-recheck L-3): cap + validate the client symbol list — a
      // 500-symbol comma list drove a 500-symbol backtest per request (same
      // treatment strategy-lab already had: cap 6, 12 chars, charset filter).
      const symbols = String(req.query.symbols || '').split(',').map(s => s.trim().toUpperCase())
        .filter(Boolean).filter(s => /^[A-Z0-9._-]{1,20}$/.test(s)).slice(0, 12);
      const minGrade = ['STRONG', 'ACTION', 'WATCH'].includes(String(req.query.minGrade).toUpperCase())
        ? String(req.query.minGrade).toUpperCase() : 'ACTION';
      const capital = Math.min(1_000_000, Math.max(100, parseInt(req.query.capital, 10) || 1000));
      // v10.6 (Pro Upgrade #4): strategy=regime_weighted → the SAME replay
      // with the regime multiplier layer forced on + a side-by-side plain
      // leg per symbol (identical folds) — the A/B that decides whether
      // AI_ENABLE_REGIME_WEIGHTS goes live.
      const strategy = ['regime_weighted', 'guarded'].includes(String(req.query.strategy || '').toLowerCase())
        ? String(req.query.strategy).toLowerCase() : 'weighted';
      const cfg = (() => { try { return loadConfig(); } catch { return {}; } })();
      const riskCap = Number(cfg.maxRiskPct) > 0 ? cfg.maxRiskPct : 5;
      // v21.1.0 (Phase-4): walkForward=1 → per-symbol 70/30 train/test leg +
      // overfit verdict (gate-tuning ka out-of-sample proof).
      const walkForward = ['1', 'true', 'yes'].includes(String(req.query.walkForward || '').toLowerCase());
      const out = await runBacktest({ market, symbols, minGrade, capitalPerTradeINR: capital, maxRiskPct: riskCap, currentMinConfidence: Number(cfg.minConfidence) > 0 ? Number(cfg.minConfidence) : 75, strategy, walkForward });
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'backtest failed', e);
    }
  });

  // ---------------- v10.8: NL Custom Strategy Lab (Pro Upgrade #2) ----------------
  // Natural-language strategy idea → LLM compiles a BOUNDED whitelist
  // rule-expression (never free-form code) → validated → walk-forward
  // replay on the SAME candle history the ensemble backtest uses.
  app.post('/api/ai/strategy-lab', async (req, res) => {
    try {
      const { description, market, symbols, capital } = req.body || {};
      if (!description || String(description).trim().length < 8) {
        return jsonError(res, 400, 'description required (min 8 chars — describe the entry/exit idea)');
      }
      const mkt = String(market || 'CRYPTO').toUpperCase() === 'INDIA' ? 'INDIA' : 'CRYPTO';
      const syms = Array.isArray(symbols) ? symbols.slice(0, 6).map(s => String(s).slice(0, 12)) : undefined;
      const cap = Math.min(1_000_000, Math.max(100, parseInt(capital, 10) || 1000));
      const out = await runCustomStrategyBacktest({
        description: String(description).slice(0, 800),
        market: mkt,
        symbols: syms,
        capitalPerTradeINR: cap,
        deps: depsForSignals(),
      });
      if (!out?.ok && out?.stage === 'compile') return jsonError(res, 422, out.error);
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'strategy lab failed', e);
    }
  });

  // ---------------- v6.7: swing desk (read-only ideas) ----------------
  app.get('/api/ai/swing', async (req, res) => {
    try {
      const market = String(req.query.market || 'INDIA').toUpperCase();
      // v10.13 (L-3): same cap/validate treatment as backtest.
      const symbols = String(req.query.symbols || '').split(',').map(s => s.trim().toUpperCase())
        .filter(Boolean).filter(s => /^[A-Z0-9._-]{1,20}$/.test(s)).slice(0, 12);
      res.json(await getSwingBoard(market === 'CRYPTO' ? 'CRYPTO' : 'INDIA', symbols.length ? symbols : undefined));
    } catch (e) {
      jsonError(res, 500, 'swing board failed', e);
    }
  });

  // ---------------- v6.7: whale radar ----------------
  app.get('/api/ai/whales', async (req, res) => {
    try {
      const market = String(req.query.market || 'CRYPTO').toUpperCase();
      // v10.13 (L-3): same cap/validate treatment as backtest.
      const symbols = String(req.query.symbols || '').split(',').map(s => s.trim().toUpperCase())
        .filter(Boolean).filter(s => /^[A-Z0-9._-]{1,20}$/.test(s)).slice(0, 12);
      res.json(await scanWhales(market === 'INDIA' ? 'INDIA' : 'CRYPTO', symbols.length ? symbols : undefined));
    } catch (e) {
      jsonError(res, 500, 'whale radar failed', e);
    }
  });

  // ---------------- v6.7: tamper-evident signal ledger ----------------
  app.get('/api/ai/ledger', (req, res) => {
    try {
      const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 20));
      res.json({ ...ledgerStatus(), verify: verifyLedger(), recent: recentEntries(limit) });
    } catch (e) {
      jsonError(res, 500, 'ledger failed', e);
    }
  });

  // ---------------- accuracy-plan Phase 4: PORTFOLIO AI OVERLAY ----------------
  // POST /api/ai/portfolio-narrative — the client's OWN computed
  // insights (sync-truth quant) cross-checked against the live
  // MacroRegime seats + the top holdings' fresh ensemble views, red
  // flags raised, and ONE LLM narration in plain Hinglish. The client
  // stays the quant source of truth; the server adds the AI layer it
  // cannot compute client-side (regime + ensemble views).
  app.post('/api/ai/portfolio-narrative', async (req, res) => {
    try {
      const body = req.body || {};
      const insights = body.insights && typeof body.insights === 'object' ? body.insights : {};
      const holdings = Array.isArray(body.holdings)
        ? body.holdings.slice(0, 12).map(h => ({
            label: String(h?.label || '').slice(0, 24),
            group: ['india', 'usa', 'crypto'].includes(h?.group) ? h.group : 'crypto',
            weightPct: Number(h?.weightPct) || 0,
            plPct: Number.isFinite(Number(h?.plPct)) ? Number(h.plPct) : null,
            valINR: Number(h?.valINR) || 0,
          })).filter(h => h.label)
        : [];
      const totalValueINR = Number(body.totalValueINR) || 0;
      if (holdings.length === 0 && !insights.health) {
        return jsonError(res, 400, 'insights/holdings required (client quant payload)');
      }
      // the server-side layers the client cannot compute: live regimes
      // + fresh ensemble views on the top holdings.
      const [regimeIndia, regimeCrypto] = await Promise.all([
        buildRegime('INDIA').catch(() => null),
        buildRegime('CRYPTO').catch(() => null),
      ]);
      const mkOf = { india: 'INDIA', usa: 'CRYPTO', crypto: 'CRYPTO' };
      const aiViews = {};
      await Promise.allSettled(holdings.slice(0, 8).map(async (h) => {
        const board = await getSignals(mkOf[h.group] || 'CRYPTO', depsForSignals(), { limit: 40 }).catch(() => null);
        const row = (board?.signals || []).find(s => String(s?.symbol || '').toUpperCase() === h.label.toUpperCase());
        if (row) aiViews[h.label.toUpperCase()] = { side: row.side, confidence: row.confidence, grade: row.grade };
      }));
      const redFlags = portfolioRedFlags(
        { marketSplit: insights.marketSplit, health: insights.health, topWeight: insights.topWeight, holdings },
        { regimes: { INDIA: regimeIndia, CRYPTO: regimeCrypto }, aiViews },
      );
      // v20.2: 84 → last-known-good rate (disk-backed, ~0 error vs ~5%)
      let usdInr = usdInrFallback();
      try { usdInr = (await fetchUsdInr()) || usdInrFallback(); } catch { /* default */ }
      const narration = await narratePortfolio({ insights, redFlags, holdings, totalValueINR, usdInr }, { KEYS: depsForSignals()?.KEYS });
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        redFlags,
        narrative: narration.narrative,
        source: narration.source,
        regime: {
          INDIA: regimeIndia ? { label: regimeIndia.label || regimeIndia.regime || null } : null,
          CRYPTO: regimeCrypto ? { label: regimeCrypto.label || regimeCrypto.regime || null } : null,
        },
        aiViews,
      });
    } catch (e) {
      jsonError(res, 500, 'portfolio narrative failed', e);
    }
  });

  // ---------------- v10.1: crypto desk AI agent (chat) ----------------
  // The CoinDCX tab's conversational agent — same pattern as
  // POST /api/intraday-agent (messages[] in, tool-calling ReAct loop,
  // Gemini→Groq→Cerebras chain). Auth required (AI cost).
  app.post('/api/crypto-agent', async (req, res) => {
    try {
      const { messages = [] } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return jsonError(res, 400, 'messages[] required');
      }
      // Bound token cost: last 24 turns, 6k chars per message (same
      // contract as the intraday agent route).
      const trimmed = messages.slice(-24).map(m => ({
        role: ['user', 'assistant', 'system'].includes(m?.role) ? m.role : 'user',
        content: String(m?.content || '').slice(0, 6000),
      }));
      const result = await runCryptoAgent(trimmed, depsForSignals());
      if (!result.ok) return jsonError(res, 502, result.error);
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (e) {
      jsonError(res, 500, 'crypto agent failed', e);
    }
  });

  // ---------------- v6.7: CoinDCX public orderbook ----------------
  app.get('/api/ai/orderbook', async (req, res) => {
    try {
      const symbol = String(req.query.symbol || 'BTC').toUpperCase();
      // v20.7.12 [L-3]: charset validation (candles/replay parity)
      if (!/^[A-Z0-9._-]{1,20}$/.test(symbol)) { jsonError(res, 400, 'invalid symbol format'); return; }
      const out = await getOrderbook(symbol);
      if (!out?.ok) return res.status(502).json(out);
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'orderbook failed', e);
    }
  });

  // ---------------- v10.6: L2 depth ladder (order-flow reader) ----------------
  // Pro Upgrade #1 — the depth-ladder mini-widget's feed: top-5 ladder
  // + two-band imbalance + walls + spoof velocity. 2s server cache
  // (positionsStream fast tier) so N viewers share ONE upstream call.
  app.get('/api/ai/depth', async (req, res) => {
    try {
      const market = ['CRYPTO', 'FUTURES', 'INDIA'].includes(String(req.query.market || '').toUpperCase())
        ? String(req.query.market).toUpperCase() : 'CRYPTO';
      const symbol = String(req.query.symbol || 'BTC').toUpperCase().slice(0, 12);
      const ltpNum = Number(req.query.ltp);
      const out = await readDepth(market, symbol, { ltp: Number.isFinite(ltpNum) && ltpNum > 0 ? ltpNum : null });
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'depth failed', e);
    }
  });

  // ---------------- v6.7: morning brief (one-call desk overview) ----------------
  app.get('/api/ai/brief', async (_req, res) => {
    try {
      const [indiaBoard, cryptoBoard, whales, positions, quotes] = await Promise.all([
        getSignals('INDIA', depsForSignals(), { limit: 5 }).catch(() => null),
        getSignals('CRYPTO', depsForSignals(), { limit: 5 }).catch(() => null),
        scanWhales('CRYPTO').catch(() => null),
        getPositionsWithPnl().catch(() => ({ positions: [], entries: [] })),
        fetchYahooQuotes(['NIFTY', 'INDIAVIX', 'BTC']).catch(() => ({})),
      ]);
      const risk = getRiskState();
      const swing = await getSwingBoard('INDIA').catch(() => null);
      const top = (b) => (b?.signals || []).filter(s => s.grade === 'STRONG' || s.grade === 'ACTION').slice(0, 3)
        .map(s => ({ symbol: s.symbol, side: s.side, grade: s.grade, confidence: s.confidence, ltp: s.ltp,
          plan: s.plan ? { entry: s.plan.entry, stopLoss: s.plan.stopLoss, target2: s.plan.target2 } : null }));
      const openPositions = (positions?.positions || []).filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN');
      // v6.11 (glama oneqaz next-actions): morning brief ke saath "ab kya
      // karein" — brief ke hi data se derive, no extra board fetch.
      const briefActions = [];
      if (risk?.config?.killSwitch) briefActions.push({ id: 'kill', label: 'Kill switch ON — trading band hai.', kind: 'warning' });
      briefActions.push(isNseOpen()
        ? { id: 'nse-open', label: 'NSE OPEN — intraday window live hai.', kind: 'info' }
        : { id: 'nse-closed', label: 'NSE CLOSED — swing/crypto desk dekho ya 09:15 wapas aao.', kind: 'info' });
      if (openPositions.length > 0) briefActions.push({ id: 'book', label: `${openPositions.length} open — console me SL/trailing check karo.`, kind: 'book' });
      const si = top(indiaBoard)[0], sc = top(cryptoBoard)[0];
      if (si) briefActions.push({ id: 'india-top', label: `🇮🇳 top: ${si.symbol} ${si.side} ${si.confidence}%`, kind: 'signal', market: 'INDIA', symbol: si.symbol });
      if (sc) briefActions.push({ id: 'crypto-top', label: `₿ top: ${sc.symbol} ${sc.side} ${sc.confidence}%`, kind: 'signal', market: 'CRYPTO', symbol: sc.symbol });
      res.json({
        ok: true,
        asOf: new Date().toISOString(),
        nseOpen: isNseOpen(),
        nextActions: briefActions,
        market: {
          nifty: quotes['NIFTY']?.price ?? null,
          niftyChangePct: quotes['NIFTY']?.changePct ?? null,
          indiaVix: quotes['INDIAVIX']?.price ?? null,
          btc: quotes['BTC']?.price ?? null,
          btcChangePct: quotes['BTC']?.changePct ?? null,
        },
        topSignals: { india: top(indiaBoard), crypto: top(cryptoBoard) },
        swingTop: (swing?.ideas || []).slice(0, 3).map(i => ({ symbol: i.symbol, side: i.side, grade: i.grade, score: i.score, ltp: i.ltp })),
        whales: (whales?.whales || []).slice(0, 3),
        book: {
          openPositions: openPositions.map(p => ({ market: p.market, symbol: p.symbol, side: p.side, mode: p.mode, qty: p.qty,
            uPnl: p.uPnlINR ?? p.pnlINR ?? null, sl: p.sl ?? null })),
          todayRealized: risk.stats?.realizedPnlINR ?? null,
          tradesToday: risk.stats?.tradesCount ?? 0,
          caps: {
            dailyMaxTrades: risk.config?.dailyMaxTrades, dailyMaxLossINR: risk.config?.dailyMaxLossINR,
            maxOpenPositions: risk.config?.maxOpenPositions, blocked: risk.blocked,
          },
        },
        ledger: ledgerStatus(),
        adaptive: adaptiveStatus(),
        note: 'Morning brief — one call, the whole desk. Data is cached at the source boards; nothing here is an order.',
      });
    } catch (e) {
      jsonError(res, 500, 'brief failed', e);
    }
  });

  // ---------------- v6.11: trust layer (calibration + governance) ----------------
  app.get('/api/ai/trust', async (_req, res) => {
    try {
      // v10.6 (Pro Upgrades #4/#5): the walk-forward dashboard's data —
      // per-model 30/90d windows + the live regime reweight state.
      const [regimeIndia, regimeCrypto] = await Promise.all([
        buildRegime('INDIA').catch(() => null),
        buildRegime('CRYPTO').catch(() => null),
      ]);
      res.json({
        ok: true,
        calibration: trustReport(),
        governance: governance(),
        windows: modelPerformanceWindows(),
        regimeReweight: {
          INDIA: regimeReweightView(regimeIndia, 'INDIA'),
          CRYPTO: regimeReweightView(regimeCrypto, 'CRYPTO'),
        },
        // v11.6 Phase 4: the mesh-backed seats join the SAME calibration
        // display — shadow/voting mode, when-voted vs when-abstained
        // win-rates, edge, and the false-diversity correlation guard,
        // right alongside the original models.
        meshModels: {
          accountability: meshModelAccountability(),
          correlation: meshCorrelationView(),
        },
        // accuracy-plan Phase 2.1: the MTF-vs-plain-15m A/B verdict —
        // both arms journaled on every settled execution since this
        // release; this block answers "is w1.6 genuinely better than
        // w1.3" with measured separation + Brier, never guesses.
        mtfAB: mtfABReport(),
      });
    } catch (e) {
      jsonError(res, 500, 'trust report failed', e);
    }
  });

  // ---------------- v13.2 B6: bandwidth telemetry ----------------
  // Rolling-24h wire accounting (REST socket deltas + SSE frame bytes),
  // 30-day projection vs the Render free-tier cap, per-scope breakdown.
  // The "measure before/after" instrument for every bandwidth fix.
  app.get('/api/ai/bandwidth', (_req, res) => {
    try {
      res.json(bandwidthView());
    } catch (e) {
      jsonError(res, 500, 'bandwidth view failed', e);
    }
  });

  // ---------------- v13.2 A5: MCP tool-call governance ----------------
  // Rate-limit state + the bounded audit ring for EVERY desk-agent tool
  // call (crypto + intraday + telegram). placeOrder-class flags included.
  app.get('/api/ai/mcp-audit', (_req, res) => {
    try {
      res.json(mcpAuditView());
    } catch (e) {
      jsonError(res, 500, 'mcp audit view failed', e);
    }
  });

  // ---------------- v13.2 A4: portfolio risk analytics ----------------
  // REAL Sharpe/Sortino (downside deviation, not sharpe×1.3) per holding
  // + portfolio, correlation matrix on aligned daily returns, vol-parity
  // rebalance drift — computed server-side where the candle history lives,
  // cached 1h. Assets come from the portfolioSync snapshot (INDMoney +
  // CoinDCX legs, hidden rows already excluded).
  app.get('/api/ai/portfolio-risk', async (req, res) => {
    try {
      const snap = getAssetsSnapshot() || {};
      const assets = Array.isArray(snap.assets) ? snap.assets : [];
      if (assets.length === 0) {
        return res.json({ ok: false, reason: 'no synced assets — Portfolio tab me Sync Now karke dobara try karo' });
      }
      const rfAnnualPct = Number(req.query.rfPct) > 0 ? Number(req.query.rfPct) : undefined;
      const out = await computePortfolioRiskAnalytics(assets, { rfAnnualPct });
      res.json(out);
    } catch (e) {
      jsonError(res, 500, 'portfolio risk analytics failed', e);
    }
  });

  // ---------------- v10.6: order-flow + price-validation status ----------------
  app.get('/api/ai/orderflow-status', (_req, res) => {
    try {
      res.json({ ok: true, depth: depthStatus(), wickFilter: wickFilterStatus() });
    } catch (e) {
      jsonError(res, 500, 'orderflow status failed', e);
    }
  });

  // ---------------- v10.15 GAP 2: scheduled-event guard status ----------------
  // The upcoming-events view (FOMC/RBI/CPI/IIP/earnings + the graded
  // blackout/haircut tunables) — the panels' event strip + the bot's
  // future /events command read this. Pure snapshot, no side effects.
  app.get('/api/ai/event-guard', (req, res) => {
    try {
      const desk = typeof req.query.desk === 'string' ? req.query.desk : undefined;
      res.json(eventGuardStatus({ desk }));
    } catch (e) {
      jsonError(res, 500, 'event guard status failed', e);
    }
  });

  // ---------------- v11.0: GLOBAL MARKET COUNCIL ----------------
  //  GET /api/ai/council/status           flag + seats + gate + cache
  //  GET /api/ai/council/near-miss        suppressed verdicts (learning)
  //  GET /api/ai/council/calibration      per-agent track records + weights
  //  GET /api/ai/council/verdict/:symbol  DEEP verdict (6 seats + debate
  //                                      + judge, 90s-cached; user-initiated)
  app.get('/api/ai/council/status', (_req, res) => {
    try {
      res.json({ ...councilStatus(), nearMiss: nearMissStats() });
    } catch (e) {
      jsonError(res, 500, 'council status failed', e);
    }
  });

  app.get('/api/ai/council/near-miss', (req, res) => {
    try {
      const limit = Math.min(60, Math.max(5, parseInt(req.query.limit, 10) || 25));
      res.json({ ok: true, entries: nearMissList(limit), stats: nearMissStats() });
    } catch (e) {
      jsonError(res, 500, 'council near-miss failed', e);
    }
  });

  app.get('/api/ai/council/calibration', (_req, res) => {
    try { res.json(councilCalibration()); } catch (e) { jsonError(res, 500, 'council calibration failed', e); }
  });

  app.get('/api/ai/council/verdict/:symbol', async (req, res) => {
    try {
      const symbol = String(req.params.symbol || '').toUpperCase().slice(0, 16);
      const market = normMarket(req.query.market);
      const force = req.query.fresh === '1' || req.query.fresh === 'true';
      if (!symbol) return jsonError(res, 400, 'symbol required');
      // v11.0.1: route-level 25s deadline — the deep path chains a fresh
      // single-symbol ensemble run + 6 personas + debate + judge, and a
      // slow provider chain used to hang the HTTP handler for minutes.
      // On timeout the verdict KEEPS warming in the 90s council cache
      // (single-flight — a retry joins the in-flight run, never
      // double-spends), so the honest 503 says "try again", not "lost".
      // runCouncilDeep returns null when there is no signal context →
      // the honest 502 (never a verdict built on an empty matrix).
      let _verdictTimer = null;
      const out = await Promise.race([
        (async () => {
          // the deep council rides a FRESH single-symbol ensemble run so the
          // feature matrix is honest (getDeepSignal is 30s-cached itself)
          const deep = await getDeepSignal(symbol, market, depsForSignals()).catch(() => null);
          // v11.4 recheck: buildSignal emits NO `ind` — the council feature
          // matrix (rsi/adx/atr/relVolume/vwap/ema20/ema50) ran all-null on
          // this refresh path. getDeepSignal's payload carries the indicator
          // object at top level — re-attach it the same way signals.js does.
          const verdict = await runCouncilDeep({
            market, symbol,
            sig: deep?.signal ? { ...deep.signal, ind: deep.indicators ?? null } : null,
            regime: await buildRegime(market).catch(() => ({})),
            deps: depsForSignals(), force,
          });
          return verdict;
        })(),
        // v11.4 recheck: clearTimeout on settle — the losing leg's timer
        // used to linger 25s past every success (unref'd, but still the
        // "timer never cleared" anti-pattern).
        new Promise((resolve) => { _verdictTimer = setTimeout(() => resolve('timeout'), 25_000); _verdictTimer.unref?.(); }),
      ]).finally(() => { if (_verdictTimer) clearTimeout(_verdictTimer); });
      if (out === 'timeout') {
        return jsonError(res, 503, 'council verdict still computing — retry in a few seconds (result caches for 90s)');
      }
      if (!out) return jsonError(res, 502, 'council verdict unavailable (no signal context)');
      return res.json({
        ok: true,
        stamp: councilStampOf(out),
        verdict: out,
      });
    } catch (e) {
      jsonError(res, 500, 'council verdict failed', e);
    }
  });

  // ---------------- v6.11: portfolio performance analytics ----------------
  app.get('/api/ai/perf', (_req, res) => {
    try { res.json(perfReport()); } catch (e) { jsonError(res, 500, 'perf report failed', e); }
  });

  // ---------------- v21.1.0 (Phase-4): strategy health + go-live gate ----------------
  // Per-strategy rolling stats (source×market), 30-trade kill-rule state,
  // aur PAPER track-record se GO-LIVE readiness (min trades / +expectancy /
  // DD limit). UI ka StrategyHealthPanel isi pe chalta hai; executeSignal /
  // executeFuturesSignal inhi gates se LIVE/paused entries reject karte hain.
  app.get('/api/ai/strategy-health', async (_req, res) => {
    try {
      const { strategyHealthView } = await import('./strategyGuard.js');
      res.json(strategyHealthView());
    } catch (e) { jsonError(res, 500, 'strategy health failed', e); }
  });

  // ---------------- v6.11: cross-asset correlation matrix ----------------
  app.get('/api/ai/correlations', async (_req, res) => {
    try { res.json(await correlationMatrix()); } catch (e) { jsonError(res, 500, 'correlations failed', e); }
  });

  // ---------------- v6.11: sector map + context chain + F-Score ----------------
  app.get('/api/ai/sectors', async (_req, res) => {
    try { res.json(await sectorDesk()); } catch (e) { jsonError(res, 500, 'sector desk failed', e); }
  });

  // ---------------- v6.11: income setup ranker (NSE indices) ----------------
  app.get('/api/ai/income', async (_req, res) => {
    res.set('Cache-Control', 'no-store'); // v21.7.0: fresh-only parity (options family)
    try { res.json(await rankIncomeSetups()); } catch (e) { jsonError(res, 500, 'income ranker failed', e); }
  });

  // ---------------- v6.11: next-actions + followup hooks ----------------
  // Context-aware "ab kya karna chahiye" — the oneqaz conversational
  // layer: suggested actions + followup questions the UI shows as chips.
  app.get('/api/ai/next-actions', async (_req, res) => {
    try {
      const [indiaBoard, cryptoBoard, positions, risk] = await Promise.all([
        getSignals('INDIA', depsForSignals(), { limit: 5 }).catch(() => null),
        getSignals('CRYPTO', depsForSignals(), { limit: 5 }).catch(() => null),
        getPositionsWithPnl().catch(() => ({ positions: [] })),
        Promise.resolve(getRiskState()),
      ]);
      const actions = [];
      const followups = [];

      if (risk?.config?.killSwitch) {
        actions.push({ id: 'kill', label: '⚠️ Kill switch ON hai — trading band. Wapas karna ho to Risk settings me toggle karo.', kind: 'warning' });
      }
      const open = (positions?.positions || []).filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN');
      const nseOpenNow = isNseOpen();
      actions.push(nseOpenNow
        ? { id: 'nse-open', label: 'NSE OPEN hai (09:15–15:30) — India intraday window live, Top-5 picks refresh ho rahe hain.', kind: 'info' }
        : { id: 'nse-closed', label: 'NSE CLOSED — India entries LIVE-blocked hain; swing setups + crypto desk dekho, ya subah 09:15 wapas aao.', kind: 'info' });
      if (open.length > 0) {
        const losing = open.filter(p => (p.uPnlINR ?? p.pnlINR ?? 0) < 0).length;
        actions.push({ id: 'book', label: `${open.length} open position${open.length > 1 ? 's' : ''} (${losing} red) — Execution Console me trailing/SL state check karo.`, kind: 'book' });
        followups.push(`${open[0]?.symbol} ka abhi SL/T2 kahan hai?`);
      }
      const strong = (b) => (b?.signals || []).find(s => s.grade === 'STRONG');
      const si = strong(indiaBoard), sc = strong(cryptoBoard);
      if (si) actions.push({ id: 'india-strong', label: `🇮🇳 STRONG: ${si.symbol} ${si.side} ${si.confidence}% — deep scan chala ke plan dekho.`, kind: 'signal', market: 'INDIA', symbol: si.symbol });
      if (sc) actions.push({ id: 'crypto-strong', label: `₿ STRONG: ${sc.symbol} ${sc.side} ${sc.confidence}% — deep scan + orderbook ek saath dekho.`, kind: 'signal', market: 'CRYPTO', symbol: sc.symbol });
      if (si || sc) followups.push((si || sc).symbol + ' par kya invalidate hoga?');

      const led = ledgerStatus();
      if (led?.open > 0) actions.push({ id: 'ledger-open', label: `Ledger me ${led.open} entries abhi settle nahi hue — positions close hone par outcome hash-chain me lock hoga.`, kind: 'ledger' });
      const tgCfg = telegramConfig(TG || {});
      if (!tgCfg) {
        actions.push({ id: 'tg-setup', label: 'Telegram configured nahi — Alerts & AI Keys me bot-token/chat-id daalo, STRONG signals + fills wahan pingen.', kind: 'setup' });
      }
      if (risk?.blocked && Object.values(risk.blocked || {}).some(Boolean)) {
        actions.push({ id: 'caps', label: 'Koi risk-cap breached hai aaj — guards panel dekho, naya entry block ho sakta hai.', kind: 'warning' });
      }
      followups.push(
        'Sector rotation me kaunsa sector strongest hai?',
        'NIFTY ka GEX / gamma-flip level kya hai?',
        'BTC aur NIFTY ka correlation abhi kya hai?',
        'Engine ki calibration kitni sahi hai?',
      );
      res.json({
        ok: true,
        asOf: Date.now(),
        nseOpen: nseOpenNow,
        actions,
        followups: followups.slice(0, 6),
        note: 'Next-actions = desk state se derive kiye gaye suggestions. Followup chips = existing panels ka shortcut. Read-only.',
      });
    } catch (e) {
      jsonError(res, 500, 'next-actions failed', e);
    }
  });

  // ---------------- v10.9: instant-push pipeline status ----------------
  // The legacy bot's 10-min backup cron consults this — healthy pipeline
  // means the cron stays silent.
  app.get('/api/ai/insta-push/status', (_req, res) => {
    try { res.json(instaPushStatus()); } catch (e) { jsonError(res, 500, 'insta-push status failed', e); }
  });

  // v10.9: the approval flow's execution path — same gauntlet as
  // POST /api/ai/execute, source-tagged for the journal audit.
  _approvedExec = async ({ symbol, side, mode, qtyINR, leverage } = {}) => executeSignal({
    symbol: String(symbol || '').toUpperCase(),
    side: side ? String(side).toUpperCase() : undefined,
    mode: mode === 'live' ? 'live' : mode === 'notify' ? 'notify' : 'paper',
    qtyINR: qtyINR != null ? Number(qtyINR) : undefined,
    leverage: leverage != null ? Number(leverage) : undefined,
    getFreshSignal: (pair, o) => getFreshSignalForExec(pair, depsForSignals(), o),
    wantAuto: false,
    source: 'telegram-approval',
    sendTelegram,
  });

  // ---------------- v10.9: pair correlation (alert bundling) ----------------
  // The price-alert watcher calls this to decide whether two alerts that
  // fired in the same 20s window are really ONE correlated move (BTC + ETH
  // breaking out together = one notification, not two).
  app.get('/api/ai/pair-correlation', async (req, res) => {
    try {
      const a = String(req.query.a || '').toUpperCase().slice(0, 12);
      const b = String(req.query.b || '').toUpperCase().slice(0, 12);
      if (!/^[A-Z0-9]{1,12}$/.test(a) || !/^[A-Z0-9]{1,12}$/.test(b) || a === b) {
        return res.status(400).json({ ok: false, error: 'a and b required (distinct symbols)' });
      }
      const r = await pairCorrelation(a, b);
      res.json({ ok: true, a, b, r, note: '60d daily-return Pearson. null = data unavailable (never a fake 0).' });
    } catch (e) { jsonError(res, 500, 'pair correlation failed', e); }
  });

  // ---------------- v10.9: weekly trade-performance review ----------------
  // /weeklyreview — journal + calibration → quant numbers → one LLM
  // narration. Same compute the Sunday auto-push uses.
  app.post('/api/ai/weekly-review', async (_req, res) => {
    try {
      const out = await runWeeklyPerformanceReview({ KEYS: effectiveKeys(), OPENAI_COMPAT });
      if (!out.ok) return res.status(400).json(out);
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) { jsonError(res, 500, 'weekly review failed', e); }
  });
  app.get('/api/ai/weekly-review/status', (_req, res) => {
    try { res.json(weeklyReviewStatus()); } catch (e) { jsonError(res, 500, 'weekly review status failed', e); }
  });

  // ============================================================
  // v20.6.3: SELF-IMPROVEMENT ENGINE ROUTES — COMPLETELY REMOVED.
  // The 14 /api/ai/self/* handlers (status, repair, harvest, drift,
  // retrain, lessons, lessons/run, gate-tune, evolve, proposals,
  // proposal/:id/approve|reject|rollback) were here. Removed because
  // the user explicitly asked to "completely remove" the loop. The
  // module FILES remain (council.js dynamically imports lessonsEngine
  // for the lessonsBlock prompt — deleting would crash that path).
  // If you need to call them manually: re-add the imports + the 14
  // handlers from git history (commit before v20.6.3).
  // ============================================================

  // ---------------- alerts + AI council keys (v6.5) ----------------
  app.get('/api/ai/alerts/config', (_req, res) => {
    try {
      const tg = telegramConfig(TG || {});
      res.json({ ok: true, status: secretsStatus(), telegram: { configured: !!tg, source: tg?.source || null } });
    } catch (e) { jsonError(res, 500, 'alerts config failed', e); }
  });

  app.post('/api/ai/alerts/config', (req, res) => {
    try {
      const body = req.body || {};
      const applied = [];
      for (const key of ['telegramBotToken', 'telegramChatId', 'geminiApiKey', 'groqApiKey']) {
        if (key in body) {
          setSecret(key, body[key] == null || body[key] === '' ? null : String(body[key]));
          applied.push(key);
        }
      }
      if (applied.length === 0) return res.status(400).json({ ok: false, error: 'nothing to save (send telegramBotToken / telegramChatId / geminiApiKey / groqApiKey)' });
      res.json({ ok: true, applied, status: secretsStatus() });
    } catch (e) {
      const status = e?.status || 400;
      return res.status(status).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/ai/alerts/test', async (_req, res) => {
    try {
      const out = await sendTelegram(
        '🤖 <b>SmartAI AI Trading</b> — test message\nAlerts are LIVE. STRONG signals, fills and SL/TP closes will ping you here.',
      );
      if (!out.ok) return res.status(400).json(out);
      res.json(out);
    } catch (e) { jsonError(res, 500, 'alerts test failed', e); }
  });

  // ---------------- Dhan connect (v6.5) ----------------
  app.post('/api/ai/dhan/connect', async (req, res) => {
    try {
      const { clientId, accessToken } = req.body || {};
      if (clientId == null || accessToken == null) {
        return res.status(400).json({ ok: false, error: 'clientId and accessToken required (Dhan app → Profile → API/Apps)' });
      }
      dhanConnect(clientId, accessToken);
      // Validate with a profile ping — bad creds fail HERE, not on an order.
      let profile = null;
      try { profile = await dhanProfile(); } catch (e) {
        dhanDisconnect();
        return res.status(400).json({ ok: false, error: `Dhan rejected the token: ${String(e?.message || e).slice(0, 150)}` });
      }
      const scrips = await scripMasterStatus().catch(() => ({ cached: false, symbols: 0 }));
      res.json({ ok: true, profile: { name: profile?.name || null, clientId: profile?.clientId || null }, scrips });
    } catch (e) {
      const status = e?.status || 400;
      return res.status(status).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/ai/dhan/disconnect', (_req, res) => {
    try { dhanDisconnect(); res.json({ ok: true }); }
    catch (e) { return res.status(400).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.get('/api/ai/dhan/status', async (_req, res) => {
    try {
      const scrips = await scripMasterStatus().catch(() => ({ cached: false, symbols: 0, updatedAt: null }));
      let profile = null;
      if (dhanConnected()) profile = await dhanProfile().catch(() => null);
      res.json({ ok: true, connected: dhanConnected(), scrips, profile: profile ? { name: profile.name || null, clientId: profile.clientId || null } : null });
    } catch (e) { jsonError(res, 500, 'dhan status failed', e); }
  });

  // ---------------- background loops ----------------
  // v20.7.12 [H3-1]: SINGLE-FLIGHT GUARDS — watchPositions ke paas apna
  // internal _watchInflight join hai (v18.9), par futures/global/india
  // watchers seedha withJournalLock pakadte the aur ek brownout me >60s
  // chalne wala pass agle tick ko queue kar deta tha — SL enforcement
  // saare desks ke liye serialize + fall behind + burst hota tha. Ab har
  // watcher apne inflight guard se SKIP karta hai (next 60s tick phir
  // try karega — drop nahi, defer).
  const _watchGuard = () => { let inflight = null; return (start) => { if (inflight) return null; inflight = start().finally(() => { inflight = null; }); return inflight; }; };
  const _futGuard = _watchGuard();
  const _globGuard = _watchGuard();
  const _indiaGuard = _watchGuard();

  // Crypto position watcher — SPOT SL/TP + trailing every 60s.
  const watcher = setInterval(async () => {
    try {
      const closures = await watchPositions({ sendTelegram });
      if (closures.length > 0) {
        console.log(`[ai] watcher closed ${closures.length} position(s): ${closures.map(c => `${c.pair} ${c.pnlINR}`).join(', ')}`);
      }
    } catch { /* non-fatal */ }
    // v21.23.1 CROSS-ENGINE DIRECTION-LOCK RELEASE SWEEP (60s, ALWAYS-ON):
    // `acquireDirectionLock()` ke baad release kabhi nahi hota tha → ek trade
    // khulte hi us symbol par opposite side restart tak block rehti thi.
    // Ab har minute ALL open-position books se open-symbol set ban kar
    // `reconcileDirectionLocks()` flat symbols ke ACTIVE locks release karta
    // hai (post-entry flip cooldown preserved — immediate whipsaw flip phir
    // bhi blocked). Books: paper engine, MTF auto book (live+paper mirror),
    // shared journal (agent/india-agent/manual), SAPTA pro-trader journal.
    try {
      const openNow = [];
      for (const t of (getPaperSummaryExec()?.open || [])) openNow.push(String(t.symbol || '').toUpperCase());
      for (const b of mtfAutoOpenRows()) {
        openNow.push(String(b.symbol || '').toUpperCase());
      }
      for (const p of (loadJournal()?.positions || [])) {
        const st = String(p?.status || '').toUpperCase();
        if (st === 'OPEN' || st === 'UNKNOWN') openNow.push(String(p?.symbol || '').toUpperCase());
      }
      for (const t of (proTraderStatusView()?.positions || [])) openNow.push(String(t?.symbol || '').toUpperCase());
      const sweep = reconcileDirectionLocks(openNow);
      if (sweep.released.length > 0) {
        console.log(`[ai] direction-lock released (position flat, flip-cooldown kept): ${sweep.released.join(', ')}`);
      }
    } catch { /* sweep best-effort — never blocks the watcher */ }
  }, 60_000);
  if (watcher.unref) watcher.unref();

  // v6.8: GLOBAL FUTURES watcher — SL/TP/trailing/liquidation + exchange
  // reconcile (native TP/SL closes) + paper simulation.
  // v20.8.5: 60s → 30s — TP1/TP2 profit-booking + SL detection ka
  // worst-case latency aadha (price fetch public + single-flight hai;
  // signed listFuturesPositions sirf LIVE positions par chalti hai).
  const futuresWatcher = setInterval(async () => {
    try {
      const pass = _futGuard(() => watchFuturesPositions({
        sendTelegram,
        // v12.8: the reversal engine's ensemble gate reads the 30s-cached
        // deep path — injected here so the engine never imports signals.js.
        getDeepSignal: (sym) => getDeepSignal(sym, 'FUTURES', depsForSignals()),
      }));
      if (!pass) return; // previous pass still running — defer to next tick
      const closures = await pass;
      if (closures.length > 0) {
        console.log(`[ai] futures watcher closed ${closures.length} position(s): ${closures.map(c => `${c.pair} ${c.pnlINR}`).join(', ')}`);
      }
    } catch { /* non-fatal */ }
  }, 30_000);
  if (futuresWatcher.unref) futuresWatcher.unref();

  // v10.4: GLOBAL EQUITY FUTURES watcher — SL/TP/trailing/partial-TP/
  // liquidation sweep on the USDC perp/candle/Yahoo quote (or SIM)
  // price. v21.3.0 (Issue-6): 60s → 30s — the futures desk ka twin cadence
  // (SL/TP latency paper positions par bhi utni hi honi chahiye; quotes
  // 5s-cached hain isliye extra upstream load ~zero hai).
  const globalWatcher = setInterval(async () => {
    try {
      const pass = _globGuard(() => watchGlobalPositions({ sendTelegram }));
      if (!pass) return;
      const out = await pass;
      const closures = out?.closures || out || [];
      if (Array.isArray(closures) && closures.length > 0) {
        console.log(`[ai] global-futures watcher closed ${closures.length} position(s): ${closures.map(c => `${c.pair} ${c.pnlINR}`).join(', ')}`);
      }
    } catch { /* non-fatal */ }
  }, 30_000);
  if (globalWatcher.unref) globalWatcher.unref();

  // v6.8: SUPERINTELLIGENCE AGENT loop — wallet scan → auto entry/exit,
  // 3 trades/day. v9.7: 30s cadence (faster trend-flip reaction; the
  // wallet fetch inside the tick is throttled to ~60s). Every entry
  // still passes the same gauntlet.
  const agentLoop = setInterval(async () => {
    try {
      await agentTick(depsForSignals(), sendTelegram);
    } catch { /* non-fatal — agent logs its own errors */ }
  }, AGENT_TICK_SEC * 1000);
  if (agentLoop.unref) agentLoop.unref();

  // v18.6: PRO TRADER AUTO loop — browser-driven auto execution with the
  // USER-SPEC gates (AI 75+ / conf 65+ / verified 90+ CONFIRM). Off by
  // default; ticks are cheap no-ops until the panel starts it. LIVE
  // clicks only after the typed LIVE phrase + browser health check.
  const proTraderLoop = setInterval(async () => {
    try {
      await proTraderTick(depsForSignals(), sendTelegram);
    } catch { /* non-fatal — SAPTA logs its own errors */ }
  }, PROTRADER_TICK_SEC * 1000);
  if (proTraderLoop.unref) proTraderLoop.unref();

  // v10.3: NSE SUPERINTELLIGENCE AGENT loop — the India twin. Same 30s
  // cadence; the tick itself gates on the NSE clock (09:30–15:00
  // entries, 15:15 EOD square-off sweep, idle outside market hours),
  // so after-hours ticks are cheap no-ops. Every entry passes the SAME
  // executeIndiaSignal gauntlet a manual click passes.
  const indiaAgentLoop = setInterval(async () => {
    try {
      await indiaAgentTick(depsForSignals(), sendTelegram);
    } catch { /* non-fatal — agent logs its own errors */ }
  }, INDIA_AGENT_TICK_SEC * 1000);
  if (indiaAgentLoop.unref) indiaAgentLoop.unref();

  // v21.0.2 OPTIONS AUTO-ENTRY loop — NSE hours me har 30s tradeable
  // option cards check karke paper auto-entry (quota/cooldown gated).
  // Tick NSE-clock gated hai — after-hours me sasta no-op.
  const optionsAutoLoop = setInterval(async () => {
    try {
      await optionsAutoTick(depsForSignals(), sendTelegram);
    } catch { /* non-fatal — options auto logs its own errors */ }
  }, 30 * 1000);
  if (optionsAutoLoop.unref) optionsAutoLoop.unref();

  // v21.16.0 MTF AUTO-LINK loop — 60s. Dual-TF board banao (board + 45s row
  // caches ride karte hain), phir 75+ confirmed rows ko PAPER engine me
  // kholo. OFF by default; har tick ke gates (market open, quota, budget,
  // cooldown, kill-switch) mtfAutoLink ke andar hain. PAPER ONLY.
  const mtfAutoLoop = setInterval(async () => {
    try {
      const cfg = loadMtfAutoConfig();
      const liveCtx = await mtfAutoLiveCtx(cfg);
      await liveCtx.syncLivePositions();
      const hasOpenLinked = mtfAutoOpenCount() > 0;
      if (!mtfAutoEnabled() && !hasOpenLinked) return;
      const killSwitch = (() => { try { return !!loadConfig()?.killSwitch; } catch { return false; } })();
      if (killSwitch) return;
      const deps = depsForSignals();
      const boards = {};
      const fxLive = await mtfLiveFx();
      const hasOpenIndia = mtfAutoOpenCount('INDIA') > 0;
      for (const market of ['INDIA', 'CRYPTO']) {
        const on = market === 'INDIA' ? cfg.desks.india : cfg.desks.crypto;
        if (!on) continue;
        if (market === 'INDIA' && !isNseOpen() && !hasOpenIndia) continue;
        // v21.25.3 [BOARD-SIGNAL COMPLETENESS — 60s sweep]: UI board (mtf-dual/
        // board) builds CRYPTO from FUTURES + METALS + GLOBALFUTURES signals.
        // The engine must use the same helper — pehle metals/equity rows ke
        // boardSig missing rehte the → even ELITE rows "main AI-BOARD ensemble
        // signal unavailable" me reject hote the, jabki UI unhe ready dikhata tha.
        const boardSigs = await boardSignalsForDesk(market, deps);
        boards[market] = await getDualMtfBoard({ market, mode: cfg.mode, holdMin: cfg.holdMin, minScore: cfg.minScore, boardSigs, fx: fxLive });
      }
      await mtfAutoTick({
        boards,
        buildDualRow,
        paper: { openPaperTrade: openPaperTradeExec, closePaperTrade: closePaperTradeExec, voidPaperTrade: voidPaperTradeExec, getPaperSummary: getPaperSummaryExec, updatePaperTradeT1ClosePct, updatePaperTradeTarget2 },
        quotes: { ...getLatestQuotes().data, ...(await mtfGlobalQuoteOverlay()) },
        killSwitch: (() => { try { return !!loadConfig()?.killSwitch; } catch { return false; } })(),
        fx: fxLive,
        usdtQuotes: cfg.desks.crypto ? await mtfUsdtQuoteMap() : null,
        siteLiveActive: liveCtx.siteLiveActive,
        siteLiveByDesk: liveCtx.siteLiveByDesk,
        walletEquityINR: liveCtx.walletEquityINR,
        syncLivePositions: liveCtx.syncLivePositions,
        liveExecute: liveCtx.liveExecute,
        liveUpdateSl: liveCtx.liveUpdateSl,
        liveClose: liveCtx.liveClose,
        notify: sendTelegram,
      });
      refreshAutoTradeSuperAgent();
    } catch { /* non-fatal — mtf auto logs its own errors */ }
  }, MTF_AUTO_TICK_SEC * 1000);
  if (mtfAutoLoop.unref) mtfAutoLoop.unref();

  // v21.22.0 ULTRA-FAST REALTIME SL TRAIL AUTO-ADJUSTMENT LOOP (3s cadence):
  // Whenever any Paper or Live Auto-Trade position is open, ticks every 3 seconds
  // against live USDT/INR quotes to ratchet `peakPrice` and `trailedStopLoss`
  // immediately in real time and sync tightened SL to CoinDCX Futures.
  let _fastSlTrailBusy = false;
  const _lastCoinDcxSlSyncAt = new Map();
  const fastSlTrailLoop = setInterval(async () => {
    if (_fastSlTrailBusy) return;
    _fastSlTrailBusy = true;
    try {
      // Lightweight check — mtfAutoStatus() would run the deep monitor with a
      // stale book LTP and could persist a TP2 extension before the fresh-quote
      // pass below had a chance to act on it.
      if (mtfAutoOpenCount() <= 0) return;
      const combinedQuotes = { ...(getLatestQuotes()?.data || {}) };
      // v21.23.8: EQUITY SIM overlay — 3s fast loop ka evaluatePaper is qualified
      // GLOBALFUTURES|SYM quotes se EQUITY SIM paper trades ke SL/T1/T2 evaluate karta hai.
      Object.assign(combinedQuotes, await mtfGlobalQuoteOverlay());
      const usdtMap = await mtfUsdtQuoteMap().catch(() => null);
      if (usdtMap instanceof Map) {
        for (const [sym, px] of usdtMap.entries()) {
          if (Number(px) > 0) {
            combinedQuotes[sym] = px;
            combinedQuotes[`FUTURES|${sym}`] = px;
            combinedQuotes[`CRYPTO|${sym}`] = px;
          }
        }
      }
      const deepMon = getActiveAutoTradesDeepMonitor(combinedQuotes);
      for (const tr of (deepMon?.trades || [])) {
        if (tr.trailedStopLoss > 0 && (tr.executionMode === 'PAPER' || tr.paperId != null)) {
          // v21.23.13 [HINT-DOMAIN FIX]: deep-monitor rows `market:'CRYPTO'`
          // carry karte hain jabki unka paper-mirror row `market:'FUTURES'`
          // (USDT-perp domain, routes.js:892 wala execMarket) me store hota
          // hai — pehle `tr.market || tr.execMarket` hint 'CRYPTO' bhejta tha
          // → symbol-fallback SL-update paper row (market 'FUTURES') se
          // kabhi match nahi karta → 3s fast trail is path pe SILENT DEAD.
          // Ab execMarket (paper journal ka actual domain) pehle.
          try { updatePaperTradeStopLoss(tr.paperId ?? tr.symbol, tr.trailedStopLoss, tr.execMarket || tr.market || null); } catch { /* non-fatal */ }
        }
        // v21.24.0 ROLLING TP2: paper mirror must converge to the book target
        // even when the SL itself did not move. The call is monotonic + a cheap
        // no-op when already in sync, so run it every pass (not only on the
        // exact tick an extension was first observed — a status/preview call
        // may have consumed that flag earlier).
        if (tr.t2 > 0 && (tr.executionMode === 'PAPER' || tr.paperId != null)) {
          try { updatePaperTradeTarget2(tr.paperId ?? tr.symbol, tr.t2, tr.execMarket || tr.market || null); } catch { /* non-fatal */ }
        }
        // v21.24.0 STOP-INTEGRITY: sirf transition-flag par bharosa mat karo.
        // Exchange par armed SL (lastExchangeSl, ya legacy rows ke liye
        // initialStopLoss) aur book ke trailed SL ka gap har pass compare
        // hota hai — restart ke baad bhi stale native SL silently nahi rehta.
        const bookSl = Number(tr.trailedStopLoss ?? tr.stopLoss) || 0;
        const anchorSl = Number(tr.lastExchangeSl) || Number(tr.initialStopLoss) || 0;
        const slDiverged = bookSl > 0 && anchorSl > 0 && Math.abs(bookSl - anchorSl) / anchorSl >= 0.0005;
        const slNeedsSync = Boolean(tr.slSyncPending) || slDiverged;
        if ((!tr.slTrailed && !tr.t2Extended && !tr.tpSyncPending && !slNeedsSync) || !(tr.trailedStopLoss > 0)) continue;
        if (tr.executionMode === 'LIVE' && loadCredsForOrder()) {
          const lastSync = _lastCoinDcxSlSyncAt.get(tr.symbol) || 0;
          if (Date.now() - lastSync >= 4500) {
            _lastCoinDcxSlSyncAt.set(tr.symbol, Date.now());
            const syncRes = await updateCoinDcxPositionSl({
              symbol: tr.symbol,
              positionId: tr.livePositionId,
              // v21.23.9: pehle `newStopLoss:` pass hota tha jabki signature
              // `stopLoss` padhta hai → har pass {ok:false,'invalid stopLoss'}
              // early-return → 3s ultra-fast LIVE exchange SL sync SILENT
              // DEAD CODE tha (15s deep monitor hi sync kar raha tha).
              stopLoss: tr.trailedStopLoss,
              // v21.23.10 [TP-LADDER FIX]: takeProfit ab HAMESHA t2 — pehle
              // pre-TP1 pe exchange-native TP T1 par re-arm hota tha
              // (`tr.tp1Hit ? tr.t2 : tr.t1`). CoinDCX create_tpsl FULL
              // position close karta hai, isliye pehli SL-trail (Stage-1
              // Early, +0.22R) par LIVE position POORI T1 par band ho jaati
              // thi — TP1-partial + TP2-runner design live me kabhi chalta
              // hi nahi tha (paper engine me partial hota hai isliye tests
              // me dikha nahi). Entry-arming (createFuturesTpsl tp2) + 15s
              // deep tick (b.t2) dono pehle se TP2 — ab teeno aligned.
              takeProfit: tr.t2,
            }).catch(() => null);
            // Only clear the pending flag on an explicit exchange OK. A failed
            // call must retry on the next 4.5s window, not silently leave the
            // native TP stranded at the old target.
            if (syncRes?.ok) {
              markAutoTradeTpSynced({ symbol: tr.symbol, paperId: tr.paperId, t2: tr.t2, exchange: true });
              // The same exchange call re-armed the SL — stamp it so the
              // divergence check above stops firing on every pass.
              markAutoTradeSlSynced({ symbol: tr.symbol, paperId: tr.paperId, stopLoss: tr.trailedStopLoss, exchange: true });
            }
          }
        }
      }
      try { evaluatePaper(combinedQuotes, []); } catch { /* non-fatal */ }
    } catch { /* non-fatal */ }
    finally { _fastSlTrailBusy = false; }
  }, 3000);
  if (fastSlTrailLoop.unref) fastSlTrailLoop.unref();

  // v21.7.0 (Issue-1) F&O 10-MIN REFRESH WARMER — user spec: "every 10
  // min me refresh hote rehna hai". NSE hours me har 10 min NIFTY+SENSEX
  // cards view pre-compute hota hai — site kholte hi instant fresh view
  // (cold compute ka 2-5s loading nahi) + chain fetch paths warm rehte
  // hain. After-hours tick = sasta no-op (isNseOpen gate). Browser side
  // strip 30s poll + desk 10-min auto-refresh pehle se hain.
  const optionsWarmLoop = setInterval(async () => {
    try {
      if (!isNseOpen()) return;
      await getOptionSignalsView(depsForSignals());
    } catch { /* non-fatal — next tick retries */ }
  }, 10 * 60 * 1000);
  if (optionsWarmLoop.unref) optionsWarmLoop.unref();

  // India watcher — SL/TP + trailing + 15:15 square-off (NSE hours only).
  const indiaWatcher = setInterval(async () => {
    try {
      if (!isNseOpen()) return;
      const pass = _indiaGuard(() => watchIndiaPositions({ sendTelegram }));
      if (!pass) return;
      const closures = await pass;
      if (closures.length > 0) {
        console.log(`[ai] India watcher closed ${closures.length} position(s): ${closures.map(c => `${c.pair} ${c.pnlINR}`).join(', ')}`);
      }
    } catch { /* non-fatal */ }
  }, 60_000);
  if (indiaWatcher.unref) indiaWatcher.unref();

  // v6.5 STRONG-signal alerter — telegram ping when a fresh STRONG
  // consensus appears on either desk (deduped per symbol+side, 30 min).
  // v10.9: DEMOTED to backup — the instant-push sink (telegramPush.js)
  // scans the same boards every ~30s through the SAME dedupe map, so
  // whichever path sees the signal first wins and this loop no-ops.
  // Flag off → the sink is not running and this loop IS the cadence
  // (exactly the pre-v10.9 behaviour, 60s).
  const alerter = setInterval(async () => {
    try {
      await scanStrongSignalsBackup({ getSignals, depsForSignals, tgEnv: TG });
    } catch { /* non-fatal */ }
  }, 60_000);
  if (alerter.unref) alerter.unref();

  // v10.9: the instant-push sink — 5s SL/TP level touches + 30s STRONG
  // scan, one shared dedupe with the backup alerter above.
  // v20.2: `fastWatchSpot` = the 5s front-line executor. A level touch
  // on a live SPOT position now fires watchPositions IMMEDIATELY — the
  // 60s watcher below stays the backstop. Spot has no exchange-native
  // stop (unlike futures create_tpsl), so this closes the up-to-60s
  // SL latency window on violent candles.
  startInstaPushSink({ getSignals, depsForSignals, fastWatchSpot: () => watchPositions({ sendTelegram }), tgEnv: TG });

  // v20.7.5 THE 15-SECOND SIGNAL RECHECK LOOP — the user's explicit ask:
  // "AI ko sabhi trading 80+ signals (Strong + Action) har 15 sec me
  // recheck karta rahe." Every STRONG/ACTION board signal across all
  // four desks gets a live-price recheck each 15s tick (tick store →
  // per-market cached batches — never a cold universe scan) and a
  // staggered committee re-vote (~60s/symbol, ≤3/tick via the 30s-
  // cached deep path). Flips / SL-throughs / grade drift push to
  // Telegram (own 30-min dedupe) and the /api/ai/signal-recheck panel
  // view. AI_SIGNAL_RECHECK=off disables. When no STRONG/ACTION
  // signals exist the tick is a few map reads (free).
  // v21.23.7 ULTRA-FAST TREND CAPTURE: onAutoTradeDeepTick ko NAMED const
  // me hoist kiya — 15s recheck ke alawa 10s opportunistic fast-entry probe
  // (neeche) bhi isi full evaluation path ko chalata hai. Trigger fire →
  // entry latency worst-case ~15-21s se ghatakar ~10s (warm board se).
  const onAutoTradeDeepTick = async () => {
      try {
        const cfg = loadMtfAutoConfig();
        const liveCtx = await mtfAutoLiveCtx(cfg);
        await liveCtx.syncLivePositions();
        const hasOpenLinked = mtfAutoOpenCount() > 0;
        if (!mtfAutoEnabled() && !hasOpenLinked) return;
        const fxLive = await mtfLiveFx();
        const boards = {};
        const hasOpenIndia = mtfAutoOpenCount('INDIA') > 0;
        for (const market of ['INDIA', 'CRYPTO']) {
          const on = market === 'INDIA' ? cfg.desks.india : cfg.desks.crypto;
          if (!on) continue;
          if (market === 'INDIA' && !isNseOpen() && !hasOpenIndia) continue;
          // v21.25.3 [BOARD-SIGNAL COMPLETENESS — 15s deep tick]: same merged
          // FUTURES + METALS + GLOBALFUTURES board signals as the UI route and
          // 60s sweep. Missing metals/equity boardSig made the fastest entry
          // path reject even ELITE rows with "ensemble signal unavailable".
          const boardSigs = await boardSignalsForDesk(market, depsForSignals());
          boards[market] = await getDualMtfBoard({ market, mode: cfg.mode, holdMin: cfg.holdMin, minScore: cfg.minScore, boardSigs, fx: fxLive }).catch(() => null);
        }
        await mtfAutoTick({
          boards,
          buildDualRow,
          // v21.23.7: updatePaperTradeT1ClosePct — deep monitor LIVE vol-class
          // shift pe paper trade ka TP1 partial % refresh karta hai (volTrail).
          paper: { openPaperTrade: openPaperTradeExec, closePaperTrade: closePaperTradeExec, voidPaperTrade: voidPaperTradeExec, getPaperSummary: getPaperSummaryExec, updatePaperTradeT1ClosePct, updatePaperTradeTarget2 },
          quotes: { ...getLatestQuotes().data, ...(await mtfGlobalQuoteOverlay()) },
          killSwitch: (() => { try { return !!loadConfig()?.killSwitch; } catch { return false; } })(),
          fx: fxLive,
          usdtQuotes: cfg.desks.crypto ? await mtfUsdtQuoteMap() : null,
          siteLiveActive: liveCtx.siteLiveActive,
          siteLiveByDesk: liveCtx.siteLiveByDesk,
          walletEquityINR: liveCtx.walletEquityINR,
          syncLivePositions: liveCtx.syncLivePositions,
          liveExecute: liveCtx.liveExecute,
          liveUpdateSl: liveCtx.liveUpdateSl,
          liveClose: liveCtx.liveClose,
          notify: sendTelegram,
        });
        // A fresh 15s board may have opened a trade (or a flip-reverse row).
        refreshAutoTradeSuperAgent();
      } catch { /* non-fatal */ }
    };

  startSignalRecheckLoop({
    getSignals,
    getDeepSignal,
    depsForSignals,
    send: sendTelegram,
    fetchLtp: _recheckFetchLtp,
    getMtfDualBoards: async () => {
      const warm = peekDualMtfBoards(90_000);
      if (warm.length > 0) return warm;
      const cfg = loadMtfAutoConfig();
      const fxLive = await mtfLiveFx();
      const deps = depsForSignals();
      const outBoards = [];
      const cryptoB = await getDualMtfBoard({ market: 'CRYPTO', mode: cfg.mode || 'INTRADAY', holdMin: cfg.holdMin, minScore: cfg.minScore, boardSigs: await boardSignalsForDesk('CRYPTO', deps), fx: fxLive }).catch(() => null);
      if (cryptoB) outBoards.push(cryptoB);
      if (isNseOpen()) {
        const indiaB = await getDualMtfBoard({ market: 'INDIA', mode: cfg.mode || 'INTRADAY', holdMin: cfg.holdMin, minScore: cfg.minScore, boardSigs: await boardSignalsForDesk('INDIA', deps), fx: fxLive }).catch(() => null);
        if (indiaB) outBoards.push(indiaB);
      }
      return outBoards;
    },
    onAutoTradeDeepTick,
  });

  // v21.23.7 ULTRA-FAST TREND CAPTURE — 10s opportunistic ENTRY PROBE
  // (user: "long or short trade signals trend ultra fast se capture hona
  // chahiye"). Design HONEST + FREE:
  //   • Probe sirf WARM cached boards (≤8s purane — peekDualMtfBoards) padhta
  //     hai — board recompute KABHI nahi (compute cost zero).
  //   • Cheap local pre-gates pehle: auto-link ON, desks on, kill off,
  //     session/position budget clear. Cooldown/quota/elite/anti-chase SAB
  //     gates escalation ke ANDAR mtfAutoTick me re-check hote hain — probe
  //     unhe bypass nahi karta, sirf "koi candidate dikh raha hai?" decide
  //     karta hai.
  //   • Candidate dikhe (tier ELITE/STRONG ya score>=minScore, LONG/SHORT,
  //     not-already-open, autoBlockers clear) → FULL onAutoTradeDeepTick
  //     escalation (fresh boards + live wallet ctx + har gate).
  //   • Headless (koi warm board nahi) → probe no-op; 15s recheck + 60s sweep
  //     backbone waise hi chalte hain. Busy-guard + 8s escalation dedup.
  let _fastProbeBusy = false;
  let _lastProbeEscalateAt = 0;
  const fastEntryProbeLoop = setInterval(async () => {
    if (_fastProbeBusy) return;
    _fastProbeBusy = true;
    try {
      if (!mtfAutoEnabled()) return;
      const cfg = loadMtfAutoConfig();
      if (!(cfg?.desks?.india || cfg?.desks?.crypto)) return;
      const openRows = mtfAutoOpenRows();
      const openCount = openRows.length;
      const isLiveSession = cfg.executionMode === 'live';
      // 1-session-1-trade lock (LIVE) / max positions (paper) — full tick
      // inhe re-check karta hai; ye sirf FREE zero-cost bail-out hai.
      if (isLiveSession && openCount >= 1) return;
      if (openCount >= (cfg.maxOpenPositions || 3)) return;
      try { if (loadConfig()?.killSwitch === true) return; } catch { /* non-fatal */ }
      const warm = peekDualMtfBoards(8_000);
      if (!Array.isArray(warm) || warm.length === 0) return;
      const minScore = Math.max(75, Number(cfg.minScore) || 75);
      const openSyms = new Set(openRows
        .map(b => String(normalizeLinkSymbol(b.symbol, b.market)).toUpperCase()));
      // v21.23.10 [PROBE-PARITY]: probe sirf bd.rows scan karta tha —
      // metalsRows (XAU/XAG) + equitySimRows 10s ultra-fast path se bahar
      // the (tick pool me dono included hain). Ab teeno arrays.
      const rowsOf = (bd) => [
        ...(Array.isArray(bd?.rows) ? bd.rows : []),
        ...(Array.isArray(bd?.metalsRows) ? bd.metalsRows : []),
        ...(Array.isArray(bd?.equitySimRows) ? bd.equitySimRows : []),
      ];
      const hot = warm.some(bd => bd?.ok && rowsOf(bd).some(r =>
        r?.ok
        // v21.23.10 [THRASH-CURE]: backoff-me symbols par free escalation
        // band — full tick inhe wapas skip karta hi tha (wasted deep work).
        && !isLiveAttemptBackoffActive(r.symbol)
        && (r.side === 'LONG' || r.side === 'SHORT')
        && (r.tier === 'ELITE' || r.tier === 'STRONG' || Number(r.superScore) >= minScore)
        && !(r.autoBlockers?.length)
        && !openSyms.has(String(normalizeLinkSymbol(r.symbol, bd.market)).toUpperCase())
      ));
      if (!hot) return;
      const now = Date.now();
      if (now - _lastProbeEscalateAt < 8_000) return; // 15s recheck ke saath stack nahi
      _lastProbeEscalateAt = now;
      await onAutoTradeDeepTick(); // FULL evaluation — har gate andar re-check
    } catch { /* non-fatal */ }
    finally { _fastProbeBusy = false; }
  }, 10_000);
  if (fastEntryProbeLoop.unref) fastEntryProbeLoop.unref();

  // ------------------------------------------------------------
  // v21.26.0 AI SUPER INTELLIGENCE — start the per-trade tick agent.
  // Primary path: liveFeed.subscribe → mtfAutoSuperAgentManage (same event-loop
  // turn as the upstream WebSocket tick). The 1s timer inside the agent is a
  // watchdog/fallback only. Stream holds keep headless AUTO trades fed even
  // when no browser SSE client is connected.
  // ------------------------------------------------------------
  startAutoTradeSuperAgent({
    getOpenTrades: getAutoTradeSuperAgentOpenTrades,
    getQuoteFor: superAgentQuoteFor,
    getBoardRow: superAgentBoardRow,
    getQuotes: () => (getLatestQuotes()?.data || {}),
    getFx: () => mtfLiveFx(),
    getLiveCtx: getSuperAgentLiveCtx,
    isKillSwitch: () => { try { return loadConfig()?.killSwitch === true; } catch { return false; } },
    ensureSubs: ({ crypto = [], india = [], fut = [], glob = [] } = {}) => {
      if (crypto.length) ensureCryptoSubscribed(crypto);
      if (india.length) ensureInSubscribed(india);
      if (fut.length || glob.length) ensureCxRtSubscribed({ fut, glob });
    },
    releaseSubs: ({ crypto = [], india = [], fut = [], glob = [] } = {}) => {
      if (crypto.length) releaseCryptoSubscribed(crypto);
      if (india.length) releaseInSubscribed(india);
      if (fut.length || glob.length) releaseCxRtSubscribed({ fut, glob });
    },
    clientUp: (domain) => {
      if (domain === 'crypto') cryptoClientUp();
      else if (domain === 'india') inClientUp();
      else if (domain === 'cxrt') cxRtClientUp();
    },
    clientDown: (domain) => {
      if (domain === 'crypto') cryptoClientDown();
      else if (domain === 'india') inClientDown();
      else if (domain === 'cxrt') cxRtClientDown();
    },
    paper: {
      openPaperTrade: openPaperTradeExec,
      closePaperTrade: closePaperTradeExec,
      voidPaperTrade: voidPaperTradeExec,
      getPaperSummary: getPaperSummaryExec,
      bookPaperT1Partial: bookPaperT1PartialExec,
      updatePaperTradeStopLoss,
      updatePaperTradeT1ClosePct,
      updatePaperTradeTarget2,
      evaluatePaper,
    },
    notify: sendTelegram,
  });

  // v10.16 SECTION 2: the MANUAL TRADE monitor — 5s LTP sweep + 30s
  // conviction re-vote (cached deep path) + telegram pushes on flip /
  // SL-approach / target-hits / stagnant check-ins. Parks at 60s idle
  // when no manual trades are open (free).
  // v18.6.3 REALTIME NEVER STOPS: the monitor now HOLDS the upstream
  // stream subscriptions for open trades (crypto spot / India equities /
  // CoinDCX perps) — the tick store stays fresh even when every browser
  // SSE client disconnects (app tab hidden while the user trades on the
  // exchange site). Trade close → release → idle streams park (free).
  // v21.22.0: Manual Trade Tracker & Expert Picks permanently removed from both tabs per user instruction;
  // background manual-trade monitor and expert-picks warm-up are disabled on boot.
  if (process.env.ENABLE_LEGACY_MANUAL_MONITOR === '1') {
    startManualTradeMonitor({
      getDeepSignal,
      depsForSignals,
      send: sendTelegram,
      fetchIndiaQuotes: async (syms) => fetchTVIndiaBatch(syms),
      fetchIndexSpot: async (sym) => {
        const q = await fetchYahooQuotes([sym]).catch(() => ({}));
        return q?.[sym] || null;
      },
      usdInrOf: async () => { try { return (await fetchUsdInr()) || usdInrFallback(); } catch { return usdInrFallback(); } },
      ensureSubs: ({ crypto = [], india = [], fut = [], glob = [] } = {}) => {
        if (crypto.length) ensureCryptoSubscribed(crypto);
        if (india.length) ensureInSubscribed(india);
        if (fut.length || glob.length) ensureCxRtSubscribed({ fut, glob });
      },
      releaseSubs: ({ crypto = [], india = [], fut = [], glob = [] } = {}) => {
        if (crypto.length) releaseCryptoSubscribed(crypto);
        if (india.length) releaseInSubscribed(india);
        if (fut.length || glob.length) releaseCxRtSubscribed({ fut, glob });
      },
      clientUp: (domain) => {
        if (domain === 'crypto') cryptoClientUp();
        else if (domain === 'india') inClientUp();
        else if (domain === 'cxrt') cxRtClientUp();
      },
      clientDown: (domain) => {
        if (domain === 'crypto') cryptoClientDown();
        else if (domain === 'india') inClientDown();
        else if (domain === 'cxrt') cxRtClientDown();
      },
    });
  }

  // v10.9: weekly trade-performance digest — Sunday 19:00 IST Telegram
  // push (AI_WEEKLY_REVIEW_PUSH=off). /weeklyreview runs it on demand.
  scheduleWeeklyReviewPush(() => ({ KEYS: effectiveKeys(), OPENAI_COMPAT }));

  // LEGACY SPOT AUTO-EXECUTOR — v21.23.8 me PERMANENTLY DISABLED.
  //
  // User spec: "coindcx spot trade... spot ko FULL STOP kardo — sirf
  // FUTURES USDT & EQUITY SIM aur GOLD & SILVER me hi trade lagna chahiye."
  // Ye 90s loop CoinDCX SPOT (SYM-INR) orders lagata tha (executeSignal)
  // jab MTF Auto-Trade OFF tha + legacy allowAuto config ON tha. Ab:
  //   • CoinDCX ka saucha auto-trade engine MTF Auto-Link hai (FUTURES
  //     USDT perps + XAU/XAG + EQUITY SIM) — ye loop sirf ek competing
  //     duplicate entry source tha.
  //   • executeSignal par bhi SPOT FULL STOP gate hai (coindcxOrders.js
  //     gate 0) — is loop ko zinda rakhne ka koi honest reason nahi;
  //     har attempt journal me REJECTED spam karta.
  // Loop shell sirf audit-trail ke liye rakha gaya hai (koi order kabhi
  // nahi lagega); purana behaviour AI_SPOT_FULL_STOP=0 ke saath bhi wapas
  // nahi aata — ye DEAD path hai.
  const auto = setInterval(() => {
    // v21.23.8: SPOT FULL STOP — legacy spot auto-executor permanently disabled
    // (see block comment above). Pure no-op shell: no signal scan, no
    // executeSignal call, no journal writes — CoinDCX auto-trade ka ek-matra
    // engine ab MTF Auto-Link hai (FUTURES USDT + XAU/XAG + EQUITY SIM).
  }, 90_000);
  if (auto.unref) auto.unref();

  // ---------------- v9.2.1 BOOT WARM-UP ----------------
  // Free-tier hosts (Render etc.) put the process to sleep; the first
  // user polls after wake hit COLD caches and used to time out behind
  // three full board scans ("Agent status unavailable" / "Expert
  // engine unavailable"). Pre-heat the boards ~2s after boot so the
  // first poll is warm. Expert Picks warm-up is intentionally not
  // scheduled — that UI was removed in v21.22.0. Single-flight joins
  // any request that arrives mid-warm. Disable with WARM_ON_BOOT=0.
  // v21.3.0 (Issue-1): constrained platforms (Render free dyno etc.) ab
  // warm-up ko DEFAULT-OFF karte hain — ek 0.1-CPU 512MB dyno par boot
  // ke turant baad 3 board scans + expert scans stack karna hi tha
  // "wake ke baad pehla request timeout" symptom. WARM_ON_BOOT=1 se
  // forcefully wapas ON ho jaata hai; WARM_ON_BOOT=0 hamesha OFF.
  const _warmExplicit = String(process.env.WARM_ON_BOOT || '').trim();
  const _warmConstrainedOff = (() => {
    try { return isConstrainedPlatform(process.env); } catch { return false; }
  })();
  const _warmOn = _warmExplicit === '1' ? true : _warmExplicit === '0' ? false : !_warmConstrainedOff;
  if (_warmOn) {
    const warmBoards = () => Promise.allSettled([
      getSignals('CRYPTO', depsForSignals()).catch(() => null),
      getSignals('FUTURES', depsForSignals()).catch(() => null),
      getSignals('INDIA', depsForSignals()).catch(() => null),
    ]);
    const warmer = setTimeout(() => {
      warmBoards()
        .catch(() => { /* best-effort warm */ });
    }, 2000);
    if (warmer.unref) warmer.unref();
  }

  console.log('[ai] Superintelligence Ensemble v6.13 — ORDER TICKET + SIMPLE VIEW (options trade guide: session/expiry/limit/exit · 4-step signal order guide · simple/pro desk view · v6.12 pro-trader brain: quorum caps · MTF · session phases · extension veto · swing-structure SL · trust/perf/correlation/sector desks) · v21.12 MASTER ACCURACY SWITCH: 13 core seats + tape-MTF confluence (w1.6) + V2 seats SentimentPulse/InstFlow/FundaCheck + 4 mesh shadow seats (weight 0, ledger-seeded promotion) = 16 voting + 4 shadow — AI_ACCURACY_SUITE (default ON) ke ON hone par per-flag env IGNORED; rollback sirf AI_ACCURACY_SUITE=false se · topFive ranking · Dhan + CoinDCX + GLOBAL FUTURES gauntlets · SUPERINTELLIGENCE AUTO-AGENT');
}
