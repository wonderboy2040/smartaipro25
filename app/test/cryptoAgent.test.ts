// ============================================================
// test/cryptoAgent.test.ts — CRYPTO DESK MCP AGENT (v10.1 + v10.5)
// ------------------------------------------------------------
// Pins the 12-tool registry, the FULL-TICKET prompt discipline
// (shared with the intraday agent), and the tool implementations
// that don't need network (sizing math + agent status + the v10.5
// risk-status / P&L tools via journal test hooks). Live-data
// tools are shape-checked with their fetchers mocked.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (the risk/pnl tools read the journal + config)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-crypto-agent');

// v11.4 recheck: controllable connection state (was hardcoded false —
// the connected branch of get_wallet had zero coverage, which is exactly
// how the wrong walletSnapshot key mapping survived).
const cxConnected = vi.hoisted(() => ({ on: false }));
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => cxConnected.on,
  coindcxPrivate: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
}));

const mockGetSignals = vi.fn();
const mockGetDeepSignal = vi.fn();
vi.mock('../server/ai/signals.js', () => ({
  getSignals: (...a) => mockGetSignals(...a),
  getDeepSignal: (...a) => mockGetDeepSignal(...a),
  buildRegime: vi.fn(async () => ({ btcChange: 1.2, btcTrend: 'UP' })),
  getFreshSignalForExec: vi.fn(async () => null),
  getFreshFuturesSignalForExec: vi.fn(async () => null),
}));

const mockWalletSnapshot = vi.fn();
vi.mock('../server/ai/futures.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    walletSnapshot: (...a) => mockWalletSnapshot(...a),
    fetchUsdInr: vi.fn(async () => 84),
    executeFuturesSignal: vi.fn(),
    closeFuturesPosition: vi.fn(),
  };
});

const mockAgentStatus = vi.fn();
vi.mock('../server/ai/agent.js', () => ({
  loadAgentConfig: () => ({ enabled: true, mode: 'paper', minAiScore: 75, rollingWindow: 10, minRollingWinRate: 35, correlationGuard: true, dynamicTimeExit: true, maxHoldMin: 90 }),
  agentStatus: (...a) => mockAgentStatus(...a),
}));

import {
  CRYPTO_AGENT_TOOLS, buildCryptoSystemPrompt, runCryptoAgent, __internals,
} from '../server/ai/cryptoAgent.js';
import { __setJournalForTests, __setConfigForTests, loadConfig, todayIST } from '../server/ai/coindcxOrders.js';

const { executeCryptoTool, fullTicketRules } = __internals;

const DEPS = { KEYS: {}, OPENAI_COMPAT: {} };

// ============================================================
// the tool registry — 15 tools, OpenAI function format
// (v10.8: + backtest_custom_strategy — the Strategy Lab tool)
// (v12.0: + get_perp_intel + get_win_probability — the pro trader
//  positioning + calibrated win-probability tools)
// ============================================================
describe('crypto agent registry', () => {
  it('exposes exactly the 18 planned tools (15 + news tool + v13.1 SVA verify_signal + v13.2 A5 get_model_consensus)', () => {
    const names = CRYPTO_AGENT_TOOLS.map(t => t.function.name);
    expect(names).toEqual([
      'get_live_crypto_signals', 'analyze_global_stock', 'analyze_coin', 'get_wallet', 'get_open_positions',
      'get_market_regime', 'get_track_record', 'calculate_position_size', 'get_agent_status',
      'get_funding_rate', 'get_perp_intel', 'get_win_probability', 'get_risk_status', 'get_pnl', 'backtest_custom_strategy',
      // accuracy-plan Phase 3.3: tool parity with the intraday Pro Trader agent
      'search_market_news',
      // v13.1 SIGNAL VERIFICATION AGENT — the pro-trader final verdict
      // ("XRP long ya short?" ka auditable answer)
      'verify_signal',
      // v13.2 A5 MCP standardization — per-model vote breakdown (the
      // "why did this signal fire" explanation for the chatbot)
      'get_model_consensus',
    ]);
    for (const t of CRYPTO_AGENT_TOOLS) {
      expect(t.type).toBe('function');
      expect(t.function.description.length).toBeGreaterThan(30);
    }
  });

  it('sizing tool description mandates max-sane-leverage (plan Part 1.1)', () => {
    const t = CRYPTO_AGENT_TOOLS.find(x => x.function.name === 'calculate_position_size');
    expect(t.function.description).toMatch(/max SANE leverage/i);
  });

  it('the system prompt routes funding / risk / P&L questions to the new tools', () => {
    const p = buildCryptoSystemPrompt({ utcTime: '10:30 UTC', btcRegime: 'x', fng: 'x', funding: 'x', connected: false, aiOnline: false });
    expect(p).toContain('get_funding_rate');
    expect(p).toContain('get_risk_status');
    expect(p).toContain('get_pnl');
  });

  it('v12.0: the prompt routes positioning + win-probability questions to the pro tools', () => {
    const p = buildCryptoSystemPrompt({ utcTime: '10:30 UTC', btcRegime: 'x', fng: 'x', funding: 'x', connected: false, aiOnline: false });
    expect(p).toContain('get_perp_intel');
    expect(p).toContain('get_win_probability');
    // full-ticket discipline now demands P(win) + EV on every ticket
    expect(fullTicketRules()).toMatch(/P\(win\)/);
  });
});

// ============================================================
// Part 2 — the FULL-TICKET discipline
// ============================================================
describe('full-ticket prompt discipline (Part 2)', () => {
  it('the rules demand every ticket component and reject incomplete tickets', () => {
    const r = fullTicketRules();
    for (const piece of ['Symbol + Direction', 'Entry zone', 'Stop-loss', 'Target 1, Target 2', 'Position size', 'Confidence', 'Time-window']) {
      expect(r).toContain(piece);
    }
    expect(r).toMatch(/INCOMPLETE TICKET/i);
  });

  it('crypto system prompt carries the full-ticket rules + live context', () => {
    const p = buildCryptoSystemPrompt({
      utcTime: '10:30 UTC', btcRegime: 'BTC +1.2% 24h (RISK-ON)', fng: 'Fear&Greed 56 (Greed)',
      funding: '0.34 bps/8h', connected: false, aiOnline: false,
    });
    expect(p).toContain('FULL-TICKET');
    expect(p).toContain('BTC +1.2% 24h (RISK-ON)');
    expect(p).toContain('Fear&Greed 56');
    expect(p).toMatch(/NOT CONNECTED/i); // honest wallet state
  });

  it('runCryptoAgent returns the session context + honest failure without keys', async () => {
    const out = await runCryptoAgent([{ role: 'user', content: 'test' }], { KEYS: {}, OPENAI_COMPAT: {} });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no AI keys configured/i);
    expect(out.session.utcTime).toBeTruthy();
  });

  // v10.10 — the SOL "[object Object]" report fix, end-to-end: engines
  // down must still answer a coin deep-dive with the exact-number
  // FULL TICKET from pure tool compute.
  it('runCryptoAgent: engines down + SOL deep-dive ask → deterministic FULL TICKET (ok:true)', async () => {
    mockGetDeepSignal.mockResolvedValue({
      ok: true, signal: {
        symbol: 'SOL', side: 'LONG', grade: 'STRONG', confidence: 82, agreement: 0.85,
        voters: 9, totalModels: 11, ltp: 9000, changePct: 2.1,
        superIntel: { aiScore: 83, tier: 'STRONG', blueprint: {
          entryZone: [8900, 9100], leverage: 3, maxSaneLeverage: 7, liquidation: 6200,
          leverageNote: '3× margin (sane-max 7×) · liquidation ≈ 6200',
          exitPlan: [{ at: 9400, bookPct: 40, action: 'T1 9400 — 40% book + SL breakeven' }],
          exitBy: '3h ATR clock', invalidation: 'SL 8600 break → pick cancel',
        } },
        plan: { entry: 9000, stopLoss: 8600, target1: 9400, target2: 9800, riskPct: 4.4, rewardRisk: 2, planStyle: 'atr-based' },
        quality: { veto: null, mtf: '2/3', session: 'open', stopStyle: 'swing-structure' },
        votes: [{ name: 'TrendMatrix', dir: 1, conf: 80, reasons: ['stack up'] }],
        aiNote: { note: 'strong tape' },
      },
    });
    const out = await runCryptoAgent(
      [{ role: 'user', content: 'SOL ka deep analysis karo — entry, SL, leverage sab exact numbers me' }],
      { KEYS: {}, OPENAI_COMPAT: {} },
    );
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('super-intel-deterministic');
    expect(out.degraded).toBe(true);
    expect(out.text).toContain('FULL TICKET');
    expect(out.text).toContain('SOL LONG');
    expect(out.text).toContain('9,000'); // entry
    expect(out.text).toContain('8,600'); // SL
    expect(out.text).toContain('9,400'); // T1
    expect(out.text).toContain('3×');    // leverage ladder
    // the UI tool chips light up even in deterministic mode
    expect(out.toolsUsed).toContain('analyze_coin');
    expect(out.toolsUsed).toContain('calculate_position_size');
  });
});

// ============================================================
// tool implementations (offline paths)
// ============================================================
describe('executeCryptoTool', () => {
  beforeEach(() => {
    mockGetSignals.mockReset().mockResolvedValue({ ok: true, market: 'CRYPTO', signals: [{
      symbol: 'SOL', side: 'LONG', grade: 'STRONG', confidence: 82, ltp: 9000, changePct: 2.1,
      voters: 9, totalModels: 11, agreement: 0.85, superIntel: { aiScore: 83 },
      plan: { entry: 9000, stopLoss: 8600, target1: 9400, target2: 9800, riskPct: 4.4, rewardRisk: 2 },
      aiNote: { note: 'strong tape' },
    }] });
    mockGetDeepSignal.mockReset().mockResolvedValue({
      ok: true, signal: {
        symbol: 'SOL', side: 'LONG', grade: 'STRONG', confidence: 82, agreement: 0.85,
        voters: 9, totalModels: 11, ltp: 9000, changePct: 2.1,
        superIntel: { aiScore: 83, tier: 'STRONG', drivers: ['trend'], blueprint: { entryTiming: 'NOW' } },
        plan: { entry: 9000, stopLoss: 8600, target1: 9400, target2: 9800, riskPct: 4.4, rewardRisk: 2, planStyle: 'atr-based' },
        quality: { veto: null, mtf: { phase: 'TRENDING', aligned: true }, session: { tradeable: true }, stopStyle: 'swing-structure' },
        votes: [{ name: 'TrendMatrix', dir: 1, conf: 80, reasons: ['stack up'] }],
        aiNote: { note: 'yes' },
      },
    });
    mockWalletSnapshot.mockReset();
    mockAgentStatus.mockReset().mockResolvedValue({
      ok: true, today: { tradesCount: 1, maxTrades: 3, realizedPnlINR: 40 }, accuracy: { rollingWinRate: null, rollingWindow: 10, correlationGuard: true, dynamicTimeExit: true },
      openPositions: [], blockers: [],
    });
  });

  it('get_live_crypto_signals maps the board into compact tickets', async () => {
    const out = await executeCryptoTool('get_live_crypto_signals', {}, DEPS);
    expect(out.SPOT[0]).toMatchObject({ symbol: 'SOL', side: 'LONG' });
    expect(out.SPOT[0].plan.entry).toBe(9000);
    expect(out.SPOT[0].aiScore).toBe(83);
  });

  it('analyze_coin deep-scans with votes + blueprint', async () => {
    const out = await executeCryptoTool('analyze_coin', { symbol: 'SOL' }, DEPS);
    expect(out.symbol).toBe('SOL');
    expect(out.votes[0].model).toBe('TrendMatrix');
    expect(out.blueprint.entryTiming).toBe('NOW');
  });

  it('get_wallet is honest when CoinDCX is not connected', async () => {
    const out = await executeCryptoTool('get_wallet', {}, DEPS);
    expect(out.connected).toBe(false);
    expect(out.note).toMatch(/not connected/i);
  });

  it('v11.4: get_wallet maps the REAL walletSnapshot shape (nested spot.inr / futures.usdt)', async () => {
    cxConnected.on = true;
    try {
      // the exact shape futures.js walletSnapshot returns (v10.14+)
      mockWalletSnapshot.mockResolvedValueOnce({
        ok: true, connected: true, usdInr: 86.4, fxStale: false,
        spot: { inr: { free: 8400, locked: 100, total: 8500 }, usdt: { free: 10, locked: 0, total: 10 }, error: null, rows: [] },
        futures: { usdt: { free: 6.17, locked: 1.2, total: 7.37, crossUserMargin: 0 }, error: null },
        equityINR: 14_950, deployableSpotINR: 8400, deployableFuturesUSDT: 6.17,
        fetchedAt: 1_758_000_000_000,
      });
      const out = await executeCryptoTool('get_wallet', {}, DEPS);
      // the old tool read w.spotINR / w.futuresUSDT / w.marginUsedUSDT — keys
      // that don't exist — and answered null balances with CoinDCX connected.
      expect(out.connected).toBe(true);
      expect(out.spot.balanceINR).toBe(8500);
      expect(out.spot.freeINR).toBe(8400);
      expect(out.spot.balanceUSDT).toBe(10);
      expect(out.spot.deployableINR).toBe(8400);
      expect(out.futures.balanceUSDT).toBe(7.37);
      expect(out.futures.freeUSDT).toBe(6.17);
      expect(out.futures.marginUsedUSDT).toBe(1.2);
      expect(out.futures.deployableUSDT).toBe(6.17);
      expect(out.equityINR).toBe(14_950);
      expect(out.fetchedAt).toBe(1_758_000_000_000);
    } finally {
      cxConnected.on = false;
    }
  });

  it('calculate_position_size computes qty, R-targets and MAX SANE LEVERAGE', async () => {
    const out = await executeCryptoTool('calculate_position_size', {
      entry: 50000, stopLoss: 48400, capital: 1000, riskPercent: 1.5,
    }, DEPS);
    // risk ₹15 at a ₹1600 stop distance → 0.009375 qty
    expect(out.riskAmount).toBe(15);
    expect(out.recommendedQty).toBeCloseTo(0.009375, 5);
    expect(out.target1_1R).toBe(51600);
    expect(out.target2_2R).toBe(53200);
    // stop distance 3.2% → 95/3.2 = 29.68 → capped at 10
    expect(out.maxSaneLeverage).toBe(10);
    expect(out.warning).toMatch(/liquidation/i);
  });

  it('calculate_position_size rejects junk inputs', async () => {
    expect((await executeCryptoTool('calculate_position_size', { entry: 0, stopLoss: 10 }, DEPS)).error).toBeTruthy();
    expect((await executeCryptoTool('calculate_position_size', { entry: 10, stopLoss: 10 }, DEPS)).error).toBeTruthy();
  });

  it('get_agent_status surfaces the accuracy-guard state (B1-B4 transparency)', async () => {
    const out = await executeCryptoTool('get_agent_status', {}, DEPS);
    expect(out.mode).toBe('paper');
    expect(out.correlationGuard).toBe(true);
    expect(out.rollingWinRate).toBeNull(); // honest: no sample yet
  });

  it('unknown tool → honest error', async () => {
    expect((await executeCryptoTool('make_money', {}, DEPS)).error).toMatch(/Unknown tool/i);
  });
});

// ============================================================
// v10.5 — the three gap tools (funding / risk / P&L)
// ============================================================
describe('v10.5 gap tools — get_funding_rate / get_risk_status / get_pnl', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('get_funding_rate: per-symbol 8h rate + daily carry + interpretation', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ symbol: 'BTCUSDT', markPrice: '60000', lastFundingRate: '0.00015' }),
    }));
    const out = await executeCryptoTool('get_funding_rate', { symbol: 'BTC' }, DEPS);
    expect(out.symbol).toBe('BTC');
    expect(out.fundingRate8h).toBeCloseTo(0.00015, 8);
    expect(out.fundingBps8h).toBe(1.5);
    expect(out.approxDailyCarryPct).toBeCloseTo(0.045, 5);
    expect(out.interpretation).toBeTruthy();
  });

  it('get_funding_rate: crowded-long reading is interpreted honestly', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ lastFundingRate: '0.0025' }), // 25 bps/8h
    }));
    const out = await executeCryptoTool('get_funding_rate', { symbol: 'PEPE' }, DEPS);
    expect(out.fundingBps8h).toBe(25);
    expect(out.interpretation).toMatch(/crowded longs/i);
  });

  it('get_funding_rate: unreachable feed → honest error (no fake numbers)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    const out = await executeCryptoTool('get_funding_rate', { symbol: 'BTC' }, DEPS);
    expect(out.error).toMatch(/funding fetch failed/i);
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    expect((await executeCryptoTool('get_funding_rate', { symbol: 'BTC' }, DEPS)).error).toBeTruthy();
  });

  it('get_funding_rate: junk symbol → validation error', async () => {
    expect((await executeCryptoTool('get_funding_rate', { symbol: '   ' }, DEPS)).error).toMatch(/symbol required/i);
  });

  it('get_risk_status: kill-switch + caps + the blockers verdict', async () => {
    __setConfigForTests({ ...loadConfig(), killSwitch: true, dailyMaxTrades: 3, dailyMaxLossINR: 2000, maxOpenPositions: 5 });
    __setJournalForTests({ entries: [], positions: [] });
    const out = await executeCryptoTool('get_risk_status', {}, DEPS);
    expect(out.killSwitch).toBe(true);
    expect(Array.isArray(out.blockers)).toBe(true);
    expect(out.blockers.join(' ')).toMatch(/Kill switch ON/i);
    expect(out.verdict).toMatch(/BLOCKED/i);
    // kill-switch cleared → that blocker is gone (the CoinDCX-not-connected
    // blocker legitimately stays — this suite mocks the exchange OFF)
    __setConfigForTests({ ...loadConfig(), killSwitch: false });
    const clean = await executeCryptoTool('get_risk_status', {}, DEPS);
    expect(clean.killSwitch).toBe(false);
    expect(clean.blockers.join(' ')).not.toMatch(/Kill switch/i);
  });

  it('get_pnl: realized (CLOSE + PARTIAL_TP only — NOTIFIED never counts) + win-rate + total', async () => {
    const today = todayIST(); // the journal's own day key (IST)
    const ts = Date.now();
    globalThis.fetch = vi.fn(async () => { throw new Error('offline (test)'); }); // tickers feed down → positions degrade to []
    __setConfigForTests({ ...loadConfig(), killSwitch: false });
    __setJournalForTests({
      entries: [
        { kind: 'CLOSE', day: today, ts, pnlINR: 500 },
        { kind: 'PARTIAL_TP', day: today, ts, pnlINR: 200 },
        { kind: 'CLOSE', day: today, ts, pnlINR: -100 },
        { kind: 'NOTIFIED', day: today, ts, pnlINR: 999 }, // never counts
        { kind: 'ORDER', day: today, ts, pnlINR: 999 }, // never counts
      ],
      positions: [],
    });
    const out = await executeCryptoTool('get_pnl', { period: 'today' }, DEPS);
    expect(out.period).toBe('today');
    expect(out.closedLegs).toBe(3);
    expect(out.realizedPnlINR).toBe(600);
    expect(out.wins).toBe(2);
    expect(out.losses).toBe(1);
    expect(out.winRate).toBeCloseTo(66.67, 1);
    expect(out.totalPnlINR).toBe(600); // no open positions → unrealized 0
  });

  it('get_pnl: 7d window filters old legs, all-time keeps them', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline (test)'); });
    const old = { kind: 'CLOSE', day: '2020-01-01', ts: Date.now() - 40 * 24 * 3600_000, pnlINR: 5000 };
    const recent = { kind: 'CLOSE', day: '2026-09-13', ts: Date.now() - 2 * 24 * 3600_000, pnlINR: -300 };
    __setJournalForTests({ entries: [old, recent], positions: [] });
    const w7 = await executeCryptoTool('get_pnl', { period: '7d' }, DEPS);
    expect(w7.closedLegs).toBe(1);
    expect(w7.realizedPnlINR).toBe(-300);
    const all = await executeCryptoTool('get_pnl', { period: 'all' }, DEPS);
    expect(all.closedLegs).toBe(2);
    expect(all.realizedPnlINR).toBe(4700);
  });
});

// ============================================================
// v13.2 A5 — get_model_consensus (per-model vote breakdown tool)
// ============================================================
describe('get_model_consensus tool (v13.2 A5)', () => {
  const DEEP_XRP = {
    ok: true,
    signal: {
      symbol: 'XRP', market: 'FUTURES', side: 'LONG', grade: 'WATCH',
      confidence: 52, agreement: 0.43, voters: 6, totalModels: 14,
      ltp: 1.62, aiNote: { note: 'weighted 52% LONG' },
      meta: { model: 'meta_ensemble', p: 0.61 },
      votes: [
        { id: 'trend', name: 'TrendMatrix', dir: 1, conf: 64, weight: 1.4, reasons: ['EMA stack bullish'] },
        { id: 'momentum', name: 'MomentumQuant', dir: 1, conf: 58, weight: 1.3, reasons: ['RSI 54 rising'] },
        { id: 'volatility', name: 'VolatilityScope', dir: 0, conf: 0, weight: 0.9, reasons: ['squeeze'] },
        { id: 'sr', name: 'SRMatrix', dir: -1, conf: 51, weight: 1.1, reasons: ['pivot resistance overhead'] },
      ],
      verify: {
        agent: 'SVA-v1', finalCall: 'LONG', action: 'CAUTION', score: 55,
        llm: { verdict: 'CONFIRM', confidence: 78, reason: 'clean pullback', model: 'gemini', ts: 1 },
      },
    },
  };

  it('per-model vote breakdown + tally + verifier + LLM second opinion', async () => {
    mockGetDeepSignal.mockReset().mockResolvedValue(DEEP_XRP);
    const out = await executeCryptoTool('get_model_consensus', { symbol: 'XRP' }, DEPS);
    expect(out.symbol).toBe('XRP');
    expect(out.consensus.side).toBe('LONG');
    expect(out.tally).toEqual({ bull: 2, bear: 1, abstain: 1 });
    expect(out.perModel).toHaveLength(4);
    expect(out.perModel[0]).toMatchObject({ model: 'TrendMatrix', dir: 'BULL', conf: 64 });
    expect(out.perModel[3]).toMatchObject({ model: 'SRMatrix', dir: 'BEAR' });
    expect(out.verifier).toEqual({ finalCall: 'LONG', action: 'CAUTION', score: 55 });
    expect(out.llmSecondOpinion.verdict).toBe('CONFIRM');
    expect(out.metaEnsemble.model).toBe('meta_ensemble');
  });

  it('SPOT param routes to the CRYPTO desk', async () => {
    mockGetDeepSignal.mockReset().mockResolvedValue(DEEP_XRP);
    await executeCryptoTool('get_model_consensus', { symbol: 'XRP', market: 'SPOT' }, DEPS);
    expect(mockGetDeepSignal).toHaveBeenCalledWith('XRP', 'CRYPTO', DEPS, {});
  });

  it('cold deep ensemble → honest error, no crash', async () => {
    mockGetDeepSignal.mockReset().mockResolvedValue(null);
    const out = await executeCryptoTool('get_model_consensus', { symbol: 'NOPE' }, DEPS);
    expect(out.error).toContain('No live ensemble run');
  });

  it('missing symbol → validation error', async () => {
    const out = await executeCryptoTool('get_model_consensus', {}, DEPS);
    expect(out.error).toContain('symbol required');
  });
});
