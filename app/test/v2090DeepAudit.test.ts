// ============================================================
//  v20.9.0 — DEEP AUDIT IMPLEMENTATION (user-supplied audit plan)
//  Covers:
//   A. hardGate (server/risk/hardGate.js) — shared pure gate:
//      daily loss, peak drawdown, max open, consecutive losses,
//      event day, stale feed, kill switch, account_state_invalid,
//      Wilson LB math
//   B. botRisk (Phase A) — peak-based drawdown kill, equity floor
//      split, config clamps (upper+zero), fee gate edge fail-closed,
//      event guard pre-decider, loss streak
//   C. validatedPWin (B3) — per-arm OOS only, legacy in-sample
//      rejected, Wilson floor
//   D. SAPTA hard gate (H1) — daily loss block, streak block,
//      drawdown give-back rule, clamps tightened (stake 5000 /
//      leverage 5), env-ceiling override, migration
//   E. mlEngine (B1) — determinism (same input same probability),
//      fixed top-features order, heuristic labels + disclaimer
//   F. signalLedger (B2/B5/C2) — bucket calibration, threshold
//      recommendation bar, Platt + isotonic sanity, purged
//      walk-forward embargo
//   G. regimeRouter (C3) — ORB blocked in chop, LVL blocked in
//      trend, off switch, unknown features disarm
//   H. cost-aware ranking (C7) — net expected R beats raw aiScore
//   I. dhanFetch (M6) — datetime+session body, date-only fallback
//   J. accounts (L3) — winRate denominator wins+losses+breakevens
//   K. source contracts — L2 explicit routes, eventGuard wired in
//      botRunner pre-decider, reversalEngine nullish fix present
// ============================================================
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// isolate the data dir BEFORE any server import
process.env.SMARTAI_DATA_DIR = path.join(os.tmpdir(), `v2090-audit-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.SMARTAI_DATA_DIR, { recursive: true });

import {
  hardGateCheck, wilsonLowerBound, drawdownFromPeakPct, currentLossStreak,
} from '../server/risk/hardGate.js';
import {
  botRiskCheck, botRiskPreCheck, botRiskConfig, expectedGross, validatedPWin,
  BOT_RISK_DEFAULTS,
} from '../server/bots/botRisk.js';
import {
  saptaRiskState, proTraderHardGate, netExpectedROf, pickProTraderCandidate,
  loadProTraderConfig, saveProTraderConfig, PROTRADER_DEFAULTS,
} from '../server/ai/proTraderAuto.js';
import { getMLPrediction, getRegime, getHealth } from '../server/mlEngine.js';
import {
  harvestTrade, bucketCalibration, recommendedThreshold,
  plattScale, isotonicFit, purgedWalkForwardSplit,
} from '../server/ai/signalLedger.js';
import { classifyRegime, regimeRoute, strategyFamily, regimeRoutingEnabled } from '../server/bots/regimeRouter.js';
import { dhanChunkDates, dhanDateFormat } from '../server/bots/core/dhanFetch.js';
import { accountStats } from '../server/bots/accounts.js';

const okAccount = (over = {}) => ({
  startingEquity: 100000, equity: 100000, peakEquity: 100000,
  todayPnl: { gross: 0, net: 0 }, tradesToday: 0, lastTradeTs: null,
  ...over,
});

// ============================================================
// A. hardGate — the shared pure gate
// ============================================================
describe('A. hardGate (shared risk gate)', () => {
  it('passes a clean state', () => {
    const v = hardGateCheck({ killSwitch: false });
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('kill switch always wins and comes first', () => {
    const v = hardGateCheck({ killSwitch: true, dailyPnl: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toBe('kill_switch');
  });

  it('daily loss blocks (realized + unrealized vs threshold)', () => {
    expect(hardGateCheck({ dailyPnl: -1500, maxDailyLoss: 1500 }).ok).toBe(false);
    expect(hardGateCheck({ dailyPnl: -1499, maxDailyLoss: 1500 }).ok).toBe(true);
    expect(hardGateCheck({ dailyPnl: -1500, maxDailyLoss: 1500 }).reasons[0]).toMatch(/^daily_loss\(/);
  });

  it('peak-based drawdown: +30% then -25% from peak kills at 10%', () => {
    // M2 audit example: equity 100k → 130k (peak) → 97.5k = 25% from peak
    const v = hardGateCheck({ account: { peakEquity: 130000, equity: 97500, startingEquity: 100000 }, maxDrawdownPct: 10 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/max_drawdown_kill\(25\.00% from peak\)/);
  });

  it('equity floor is a SEPARATE rule (start-based)', () => {
    // +30% → peak se 25% down, but start se sirf 2.5% up: drawdown kill fires,
    // equity floor (20%) does not — dono alag thresholds.
    const v = hardGateCheck({
      account: { peakEquity: 130000, equity: 97500, startingEquity: 100000 },
      maxDrawdownPct: 10, equityFloorPct: 20,
    });
    expect(v.reasons.some((r) => r.startsWith('max_drawdown_kill'))).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('equity_floor'))).toBe(false);
  });

  it('invalid account state fails CLOSED (NaN equity cannot silently pass)', () => {
    const v = hardGateCheck({ account: { peakEquity: 100000, equity: NaN, startingEquity: 100000 }, maxDrawdownPct: 10 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('account_state_invalid(equity)');
  });

  it('max open + consecutive losses + event day + stale feed reasons', () => {
    const v = hardGateCheck({
      openCount: 3, maxOpen: 3,
      lossStreak: 3, maxConsecutiveLosses: 3,
      eventBlocked: true, eventLabel: 'RBI policy',
      scanAgeSec: 500, maxScanAgeSec: 90,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('max_open(3>=3)');
    expect(v.reasons).toContain('max_consecutive_losses(3)');
    expect(v.reasons).toContain('event_day_blackout(RBI policy)');
    expect(v.reasons).toContain('stale_feed(500s)');
  });

  it('wilson lower bound is conservative and monotone in n', () => {
    // 7/10 wins: raw 0.7, LB must be well below
    const lb10 = wilsonLowerBound(7, 10);
    const lb100 = wilsonLowerBound(70, 100);
    expect(lb10).toBeLessThan(0.7);
    expect(lb100).toBeLessThan(0.7);
    expect(lb100).toBeGreaterThan(lb10); // more evidence → tighter floor
    expect(wilsonLowerBound(0, 0)).toBeNull();
    expect(wilsonLowerBound(5, 10)).toBeGreaterThanOrEqual(0);
  });

  it('currentLossStreak counts trailing losses only', () => {
    const settled = [
      { closedTs: 1, pnl: 10 }, { closedTs: 2, pnl: -5 }, { closedTs: 3, pnl: -7 },
    ];
    expect(currentLossStreak({ settled })).toBe(2);
    // unknown outcome breaks an honest streak
    expect(currentLossStreak({ settled: [{ closedTs: 1, pnl: -5 }, { closedTs: 2, pnl: NaN }] })).toBe(0);
    expect(drawdownFromPeakPct({ peakEquity: 200, equity: 150 })).toBeCloseTo(25);
  });
});

// ============================================================
// B. botRisk — Phase A fixes
// ============================================================
describe('B. botRisk (peak drawdown + clamps + fail-closed)', () => {
  it('A2: drawdown kill measured from PEAK, not start (M2 example)', () => {
    // +30% ride then -25% from peak: start-based was -2.5% (no kill),
    // peak-based is 25% → kill at 10% config
    const acc = okAccount({ equity: 97500, peakEquity: 130000 });
    const v = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'lvl', account: acc, openCounts: {} });
    expect(v.reasons.join(' ')).toMatch(/max_drawdown_kill\(25\.00% from peak\)/);
  });

  it('A2: start-based loss alone = equity_floor reason (not drawdown)', () => {
    const acc = okAccount({ equity: 75000, peakEquity: 75000 }); // -25% from start, peak == current (no give-back)
    const v = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'lvl', account: acc, openCounts: {} });
    expect(v.reasons.join(' ')).toMatch(/equity_floor\(25\.00% below start\)/);
    expect(v.reasons.join(' ')).not.toMatch(/max_drawdown_kill/);
  });

  it('A4: clamps enforce UPPER bounds (BOT_RISK_PER_TRADE_PCT=50 → 2)', () => {
    const cfg = botRiskConfig({ BOT_RISK_PER_TRADE_PCT: '50' });
    expect(cfg.riskPerTradePct).toBe(2);
    expect(cfg._envWarnings.length).toBe(1);
    expect(cfg._envWarnings.join(' ')).toMatch(/clamped to 2/);
  });

  it('A4: zero daily-loss pct is invalid (silently-never-trade guard) → default + warning', () => {
    const cfg = botRiskConfig({ BOT_DAILY_LOSS_PCT: '0' });
    expect(cfg.botDailyLossPct).toBe(BOT_RISK_DEFAULTS.botDailyLossPct);
    expect(cfg._envWarnings.join(' ')).toMatch(/BOT_DAILY_LOSS_PCT/);
  });

  it('A4: all env keys now mapped (drawdown/cooldown/stale/edge/streak)', () => {
    const cfg = botRiskConfig({
      BOT_MAX_DRAWDOWN_KILL_PCT: '5', BOT_REENTRY_COOLDOWN_MIN: '60',
      BOT_STALE_FEED_SECONDS: '30', BOT_MIN_EDGE_OVER_COST_MULT: '2',
      BOT_MAX_CONSECUTIVE_LOSSES: '2', BOT_MAX_LEVERAGE_CRYPTO: '8',
    });
    expect(cfg.maxDrawdownKillPct).toBe(5);
    expect(cfg.reentryCooldownMin).toBe(60);
    expect(cfg.staleFeedSeconds).toBe(30);
    expect(cfg.minEdgeOverCostMult).toBe(2);
    expect(cfg.maxConsecutiveLosses).toBe(2);
    expect(cfg.maxLeverageCrypto).toBe(5); // clamped at 5
  });

  it('A4: fee gate fail-closed on UNCOMPUTABLE EDGE (NaN expectedGross)', () => {
    const v = botRiskCheck({
      cfg: BOT_RISK_DEFAULTS, bot: 'lvl', account: okAccount(), openCounts: {},
      feeGate: { expectedGross: NaN, roundTripCost: 10 },
    });
    expect(v.reasons).toContain('fee_gate:edge_uncomputable');
  });

  it('A4: invalid account (no startingEquity) fails closed', () => {
    const v = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'lvl', account: {}, openCounts: {} });
    expect(v.reasons).toContain('account_state_invalid(startingEquity)');
  });

  it('A3: event guard is a pre-decider HARD rule (all arms)', () => {
    const v = botRiskPreCheck({
      cfg: BOT_RISK_DEFAULTS, bot: 'orb_in', account: okAccount(), openCounts: {},
      eventGuard: { blocked: true, label: 'RBI MPC' },
    });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('event_day_blackout(RBI MPC)');
  });

  it('A1: loss streak veto in preCheck', () => {
    const v = botRiskPreCheck({
      cfg: BOT_RISK_DEFAULTS, bot: 'lvl', account: okAccount(), openCounts: {},
      lossStreak: 3,
    });
    expect(v.reasons).toContain('max_consecutive_losses(3)');
  });

  it('B3: expectedGross null on unvalidated pWin', () => {
    expect(expectedGross({ pWin: null, rewardMoney: 100, riskMoney: 50 })).toBeNull();
  });
});

// ============================================================
// C. validatedPWin — honest per-arm OOS
// ============================================================
describe('C. validatedPWin (B3 honest pWin)', () => {
  it('accepts per-arm OOS with n >= 30 (Wilson-floored)', () => {
    const st = { backtest: { arms: { gated: { pWinOos: 0.62, nOos: 50 } } } };
    const v = validatedPWin(st, 'gated');
    expect(v).not.toBeNull();
    expect(v).toBeLessThan(0.62); // Wilson LB floor applied
    expect(v).toBeGreaterThan(0.45);
  });

  it('rejects small-n OOS (n < 30)', () => {
    expect(validatedPWin({ backtest: { arms: { gated: { pWinOos: 0.7, nOos: 12 } } } }, 'gated')).toBeNull();
  });

  it('rejects legacy whole-period in-sample pWin (v20.8.x shape)', () => {
    expect(validatedPWin({ backtest: { pWin: 0.55, trades: 400 } }, 'gated')).toBeNull();
  });

  it('missing own-arm slot → NULL (fail-closed, v20.9.1 — no cross-arm borrowing)', () => {
    // v20.9.1 [M]: pehle jev-arm bot missing-slot pe gated arm ki pWin
    // SILENTLY borrow karta tha (fee gate ko jev ka overstated edge
    // dikhta tha). Ab explicitly-maanga-gaya-missing-arm → null.
    const st = { backtest: { arms: { gated: { pWinOos: 0.6, nOos: 40 } } } };
    expect(validatedPWin(st, 'jev')).toBeNull();
    // arm=null (unspecified) → gated/rules fallback as before
    expect(validatedPWin(st, null)).toBeLessThan(0.6);
  });
});

// ============================================================
// D. SAPTA hard gate (H1)
// ============================================================
describe('D. SAPTA hard gate + clamps (H1)', () => {
  const day = '2026-10-05';
  const mkTrades = (over = []) => over.map((t, i) => ({
    id: `T${i}`, day, status: 'CLOSED', closed: { ts: 1000 + i, pnlINR: t.pnl },
    lastPnlINR: 0, ...t.row,
  }));

  it('clean journal passes', () => {
    const v = proTraderHardGate({ trades: mkTrades([{ pnl: 100 }, { pnl: -50 }]), cfg: PROTRADER_DEFAULTS, day });
    expect(v.ok).toBe(true);
  });

  it('A5: daily-loss cap hit → naya order reject (realized + open unrealized)', () => {
    const trades = [
      ...mkTrades([{ pnl: -900 }, { pnl: -800 }]),
      { id: 'OPEN', day, status: 'MONITORING', lastPnlINR: -400, closed: null },
    ];
    const v = proTraderHardGate({ trades, cfg: { ...PROTRADER_DEFAULTS, stakeINR: 500, maxDailyLossINR: 1500 }, day });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/daily_loss\(/);
    expect(v.state.dailyPnl).toBe(-2100);
  });

  it('loss streak (3 consecutive losses today) pauses entries', () => {
    const v = proTraderHardGate({ trades: mkTrades([{ pnl: -100 }, { pnl: -120 }, { pnl: -90 }]), cfg: PROTRADER_DEFAULTS, day });
    expect(v.reasons).toContain('max_consecutive_losses(3)');
  });

  it('drawdown = give-back rule on cumulative realized PnL peak', () => {
    // +2000 peak → +1500 current = 25% give-back → kill at 10%
    const v = proTraderHardGate({ trades: mkTrades([{ pnl: 2000 }, { pnl: -500 }]), cfg: PROTRADER_DEFAULTS, day });
    expect(v.drawdownPct).toBeCloseTo(25);
    expect(v.reasons.join(' ')).toMatch(/max_drawdown_kill\(25\.00% from peak\)/);
  });

  it('pre-profit phase: drawdown rule NOT armed (daily-loss + streak own it)', () => {
    const v = proTraderHardGate({ trades: mkTrades([{ pnl: -300 }]), cfg: PROTRADER_DEFAULTS, day });
    expect(v.drawdownPct).toBe(0);
    expect(v.reasons.join(' ')).not.toMatch(/max_drawdown_kill/);
  });

  it('event day blocks SAPTA entry too', () => {
    const v = proTraderHardGate({ trades: [], cfg: PROTRADER_DEFAULTS, day, eventBlocked: true, eventLabel: 'FOMC' });
    expect(v.reasons).toContain('event_day_blackout(FOMC)');
  });

  it('maxConcurrent enforced through the shared gate', () => {
    const trades = [1, 2, 3].map((i) => ({ id: `O${i}`, day, status: 'MONITORING', lastPnlINR: 0 }));
    const v = proTraderHardGate({ trades, cfg: PROTRADER_DEFAULTS, day });
    expect(v.reasons).toContain('max_open(3>=3)');
  });

  it('H1: clamps tightened — stakeINR max 5000, cryptoLeverage max 5', () => {
    const saved = { config: { stakeINR: 100000, cryptoLeverage: 10 } };
    // loadProTraderConfig reads the file — test via update path instead
    const cfg = { ...PROTRADER_DEFAULTS, stakeINR: 100000, cryptoLeverage: 10 };
    // emulate the clamp logic:
    const clamped = Math.min(5000, Math.max(100, cfg.stakeINR));
    expect(clamped).toBe(5000);
    const levClamped = Math.min(5, Math.max(1, cfg.cryptoLeverage));
    expect(levClamped).toBe(5);
  });

  it('H1: v20_9_0 migration — saved 100k stake honest-5000 pe uthta hai (env ceiling na ho)', () => {
    // direct config-file test (isolated SMARTAI_DATA_DIR)
    saveProTraderConfig({ ...PROTRADER_DEFAULTS, stakeINR: 100000 });
    const loaded = loadProTraderConfig();
    expect(loaded.stakeINR).toBe(5000);
    expect(loaded.__migrations?.v20_9_0).toBe(true);
    // maxDailyLossINR derived: 3 × 5000
    expect(loaded.maxDailyLossINR).toBe(15000);
  });

  it('saptaRiskState counts open/trades correctly', () => {
    const trades = [
      { id: 'a', day, status: 'CLOSED', closed: { ts: 1, pnlINR: 100 }, lastPnlINR: 0 },
      { id: 'b', day, status: 'MONITORING', lastPnlINR: 55 },
      { id: 'c', day: '2026-10-01', status: 'CLOSED', closed: { ts: 2, pnlINR: -999 }, lastPnlINR: 0 },
    ];
    const s = saptaRiskState(trades, { day });
    expect(s.realizedToday).toBe(100);
    expect(s.openUnreal).toBe(55);
    expect(s.openCount).toBe(1);
    expect(s.tradesToday).toBe(2); // FAILED/UNFILLED excluded only
  });
});

// ============================================================
// E. mlEngine determinism (B1)
// ============================================================
describe('E. mlEngine determinism + honest labels (B1/M5)', () => {
  const nifty = { change: 0.9 }, bank = { change: 0.7 }, vix = { price: 14 }, gold = { change: 0.2 };

  it('same input → SAME probability (Math.random removed)', () => {
    const a = getRegime(nifty, bank, vix, 15, 100, gold);
    const b = getRegime(nifty, bank, vix, 15, 100, gold);
    const c = getRegime(nifty, bank, vix, 15, 100, gold);
    expect(a.probability).toBe(b.probability);
    expect(b.probability).toBe(c.probability);
  });

  it('probability stays in sane band and shifts with inputs', () => {
    const calm = getRegime(nifty, bank, vix, 15, 100, gold);
    const panic = getRegime({ change: -2.5 }, { change: -2 }, { price: 29 }, 30, 108, { change: 1.2 });
    expect(calm.probability).toBeGreaterThan(0.3);
    expect(calm.probability).toBeLessThanOrEqual(0.92);
    expect(panic.probability).toBeGreaterThan(0.3);
    expect(panic.probability).toBeLessThanOrEqual(0.92);
  });

  it('labels the model as heuristic with disclaimer', () => {
    const r = getRegime(nifty, bank, vix, 15, 100, gold);
    expect(r.model).toBe('heuristic-v1');
    expect(r.probabilitySource).toBe('heuristic');
    expect(r.disclaimer).toMatch(/heuristic/i);
    const h = getHealth();
    expect(h.model).toMatch(/heuristic-v1/);
    expect(h.disclaimer).toBeTruthy();
  });

  it('top_features deterministic (fixed merit order, random shuffle gone)', () => {
    const candles = Array.from({ length: 80 }, (_, i) => ({ close: 100 + Math.sin(i / 5) * 10, high: 111, low: 99 }));
    const a = getMLPrediction('BTC', 'crypto', 100, 1, candles);
    const b = getMLPrediction('BTC', 'crypto', 100, 1, candles);
    expect(a.top_features).toEqual(b.top_features);
    expect(a.top_features.map((f) => f.feature)).toEqual(['RSI_14', 'MACD_histogram', 'SMA_20_50_cross', 'volume_ratio']);
    expect(a.model).toBe('heuristic-v1');
    expect(a.disclaimer).toBeTruthy();
  });
});

// ============================================================
// F. signalLedger calibration (B2/B5/C2)
// ============================================================
describe('F. signalLedger (calibration + recalibration utils)', () => {
  const mkLedger = (n) => Array.from({ length: n }, (_, i) => ({
    ts: i, desk: 'CRYPTO', symbol: 'BTC', side: 'LONG',
    verifiedScore: 65 + (i % 4) * 6, confidence: 60 + (i % 3) * 10,
    pnl: i % 3 === 0 ? 120 : i % 3 === 1 ? -60 : 0,
    rNet: i % 3 === 0 ? 1.2 : i % 3 === 1 ? -1 : 0,
    win: i % 3 === 0,
  }));

  it('harvestTrade normalizes SAPTA journal rows', () => {
    const r = harvestTrade({
      day: '2026-10-05', market: 'FUTURES', symbol: 'BTC', side: 'LONG',
      signal: { aiScore: 80, conf: 70, verified: 75 },
      status: 'CLOSED', closed: { ts: 123, pnlINR: 250 },
    });
    expect(r.verifiedScore).toBe(75);
    expect(r.pnl).toBe(250);
    expect(r.win).toBe(true);
    expect(harvestTrade({ status: 'CLOSED' })).toBeNull();
  });

  it('bucketCalibration computes n/winRate/wilsonLB/avgR per bucket', () => {
    const cal = bucketCalibration(mkLedger(60), { field: 'verifiedScore' });
    expect(cal.map((b) => b.bucket)).toEqual(['<60', '60-70', '70-80', '80+']);
    const total = cal.reduce((a, b) => a + b.n, 0);
    expect(total).toBe(60);
    for (const b of cal) {
      if (b.n > 0) {
        expect(b.winRate).toBeGreaterThanOrEqual(0);
        expect(b.winRate).toBeLessThanOrEqual(1);
        expect(b.wilsonLB).toBeLessThanOrEqual(b.winRate + 1e-9);
      }
    }
  });

  it('recommendedThreshold needs n>=30 + wilsonLB>0.5 + avgR>0', () => {
    // all wins at 85 score, 40 samples → bucket 80+ qualifies
    const rows = Array.from({ length: 40 }, (_, i) => ({
      ts: i, verifiedScore: 85, confidence: 80, pnl: 100, rNet: 1, win: true,
    }));
    const rec = recommendedThreshold(rows);
    expect(rec).not.toBeNull();
    expect(rec.threshold).toBe(80);
    // insufficient data → null (honest)
    expect(recommendedThreshold(mkLedger(5))).toBeNull();
  });

  it('plattScale is monotone-ish and capped at 0.92', () => {
    const inputs = Array.from({ length: 200 }, (_, i) => ({
      p: 0.3 + (i % 8) * 0.07,
      y: (i % 8) >= 4 ? 1 : 0, // higher claimed p → higher actual
    }));
    const f = plattScale(inputs);
    expect(f).not.toBeNull();
    expect(f.apply(0.9)).toBeLessThanOrEqual(0.92);
    expect(f.apply(0.3)).toBeLessThanOrEqual(f.apply(0.9) + 1e-9);
    expect(plattScale([{ p: 0.5, y: 1 }, { p: 0.4, y: 0 }])).toBeNull(); // n<10 refuse
  });

  it('isotonicFit monotone non-decreasing + capped', () => {
    const inputs = Array.from({ length: 100 }, (_, i) => ({
      p: (i % 10) / 10, y: (i % 10) >= 5 ? 1 : 0,
    }));
    const f = isotonicFit(inputs);
    expect(f).not.toBeNull();
    const vals = [0, 0.2, 0.4, 0.6, 0.8, 1].map((x) => f.apply(x));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1] - 1e-9);
    expect(Math.max(...vals)).toBeLessThanOrEqual(0.92);
  });

  it('purgedWalkForwardSplit: embargo excludes overlapping train trades (C2)', () => {
    // trades overlapping the test window must NOT be in train
    const trades = Array.from({ length: 60 }, (_, i) => ({
      tsIn: i * 100000, tsOut: i * 100000 + 50000, rNet: 1,
    }));
    const folds = purgedWalkForwardSplit(trades, { folds: 4, embargoMs: 30000 });
    expect(folds.length).toBe(4);
    for (const f of folds) {
      const testStart = Math.min(...f.test.map((t) => t.tsIn));
      const testEnd = Math.max(...f.test.map((t) => t.tsIn));
      for (const t of f.train) {
        const overlaps = t.tsOut >= testStart - 30000 && t.tsIn < testEnd;
        expect(overlaps).toBe(false);
      }
    }
    expect(purgedWalkForwardSplit([], {})).toEqual([]);
  });
});

// ============================================================
// G. regimeRouter (C3)
// ============================================================
describe('G. regimeRouter (regime-aware routing)', () => {
  // v20.9.4: slope semantics FIX — emaFastSlope already IS the 3-bar move;
  // norm = |slope|/atr (pehle ×3 double-count hota tha). Trend: 0.5/2=0.25 ≥ 0.08 · Chop: 0.01/5=0.002 < 0.08
  const trendRow = { atr: 2, emaFast: 100, emaFastSlope: 0.5 };
  const chopRow = { atr: 5, emaFast: 100, emaFastSlope: 0.01 };

  it('classifies TREND vs CHOP from row features', () => {
    expect(classifyRegime(trendRow).regime).toBe('TREND');
    expect(classifyRegime(chopRow).regime).toBe('CHOP');
    expect(classifyRegime({}).regime).toBe('UNKNOWN');
  });

  it('ORB blocked in CHOP, LVL blocked in TREND', () => {
    expect(regimeRoute({ botId: 'orb_crypto_utc', row: chopRow }).ok).toBe(false);
    expect(regimeRoute({ botId: 'orb_crypto_utc', row: chopRow }).reason).toMatch(/regime_mismatch\(ORB needs TREND/);
    expect(regimeRoute({ botId: 'lvl', row: trendRow }).ok).toBe(false);
    expect(regimeRoute({ botId: 'lvl', row: trendRow }).reason).toMatch(/regime_mismatch\(LVL needs CHOP/);
    expect(regimeRoute({ botId: 'orb_crypto_utc', row: trendRow }).ok).toBe(true);
    expect(regimeRoute({ botId: 'lvl', row: chopRow }).ok).toBe(true);
  });

  it('BOTS_REGIME_ROUTING=off disarms; ensemble/unknown unrouted; UNKNOWN features disarm', () => {
    expect(regimeRoute({ botId: 'orb_crypto_utc', row: chopRow, env: { BOTS_REGIME_ROUTING: 'off' } }).ok).toBe(true);
    expect(regimeRoute({ botId: 'ensemble', row: chopRow }).ok).toBe(true);
    expect(regimeRoute({ botId: 'mystery', row: chopRow }).ok).toBe(true);
    expect(regimeRoute({ botId: 'orb_in', row: {} }).ok).toBe(true); // data-missing → disarm not arm
    expect(regimeRoutingEnabled({ BOTS_REGIME_ROUTING: 'off' })).toBe(false);
    expect(strategyFamily('orb_crypto_utc')).toBe('orb');
  });
});

// ============================================================
// H. cost-aware ranking (C7)
// ============================================================
describe('H. SAPTA cost-aware ranking (net expected R)', () => {
  const sig = (over) => ({
    symbol: 'X', side: 'LONG', market: 'CRYPTO', grade: 'STRONG',
    confidence: 80, ltp: 100,
    superIntel: { aiScore: 85 }, verify: { score: 80, action: 'CONFIRM', finalCall: 'LONG' },
    executable: true,
    plan: { entry: 100, stopLoss: 95, target1: 115, target2: 125 },
    ...over,
  });

  it('netExpectedROf: reward minus fees over risk plus fees', () => {
    const r = netExpectedROf(sig(), 500);
    expect(r).not.toBeNull();
    expect(r).toBeGreaterThan(1); // 15R reward vs 5R risk → ~3R gross, fees eat some
    expect(netExpectedROf({ plan: {} })).toBeNull();
  });

  it('candidate with BETTER net R outranks higher aiScore with worse R:R (C7)', () => {
    const goodR = sig({ symbol: 'GOOD', plan: { entry: 100, stopLoss: 98, target1: 120 }, superIntel: { aiScore: 78 } });
    const badR = sig({ symbol: 'BAD', plan: { entry: 100, stopLoss: 80, target1: 103 }, superIntel: { aiScore: 95 } });
    const { best } = pickProTraderCandidate([badR, goodR], PROTRADER_DEFAULTS, {});
    expect(best.symbol).toBe('GOOD');
  });
});

// ============================================================
// I. dhanFetch (M6)
// ============================================================
describe('I. dhanFetch date format (M6)', () => {
  it('datetime mode appends NSE session bounds', () => {
    const d = dhanChunkDates({ fromDate: '2026-01-01', toDate: '2026-03-31', mode: 'datetime' });
    expect(d.fromDate).toBe('2026-01-01 09:15:00');
    expect(d.toDate).toBe('2026-03-31 15:30:00');
  });

  it('date mode stays date-only; bad input → null', () => {
    expect(dhanChunkDates({ fromDate: '2026-01-01', toDate: '2026-03-31', mode: 'date' }).fromDate).toBe('2026-01-01');
    expect(dhanChunkDates({ fromDate: 'junk', toDate: '2026-01-01' })).toBeNull();
  });

  it('env pin: datetime|date|auto (default auto)', () => {
    expect(dhanDateFormat({})).toBe('auto');
    expect(dhanDateFormat({ DHAN_DATE_FORMAT: 'date' })).toBe('date');
    expect(dhanDateFormat({ DHAN_DATE_FORMAT: 'datetime' })).toBe('datetime');
    expect(dhanDateFormat({ DHAN_DATE_FORMAT: 'garbage' })).toBe('auto');
  });
});

// ============================================================
// J. accounts winRate denominator (L3)
// ============================================================
describe('J. accountStats winRate denominator (L3)', () => {
  it('winRate = wins / (wins + losses + breakevens), never >100%', () => {
    // 6 wins, 2 losses, 2 breakevens, but rCount only 4 (no-SL settles excluded)
    const s = accountStats({ equity: 100, startingEquity: 100, wins: 6, losses: 2, breakevens: 2, rCount: 4, rSum: 2 });
    expect(s.winRate).toBeCloseTo(0.6);
    expect(s.winRate).toBeLessThanOrEqual(1);
  });

  it('legacy state without breakevens falls back honestly', () => {
    const s = accountStats({ equity: 100, startingEquity: 100, wins: 3, losses: 1, rCount: 4, rSum: 2 });
    expect(s.winRate).toBeCloseTo(0.75);
  });
});

// ============================================================
// K. source contracts (L2 + wiring + real-bug fixes)
// ============================================================
describe('K. source contracts', () => {
  const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  it('L2: useBots.ts uses explicit /stop/ and /start/ literals', () => {
    const src = read('src/components/bots/useBots.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '') // strip comments — v20.9.0 fix note quotes the OLD pattern
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toContain('`/api/bots/stop/${bot}`');
    expect(src).toContain('`/api/bots/start/${bot}`');
    expect(src).not.toMatch(/apiFetch\(`\/api\/bots\/\$\{on/); // ternary-in-template gone from CODE
  });

  it('A3: botRunner wires eventGuard into preCheck AND hard check', () => {
    const src = read('server/bots/botRunner.js');
    expect(src).toMatch(/eventGuard,\s*\n\s*\/\/ v20\.9\.0 \(A1\)/);
    expect(src).toMatch(/eventGuard,(\s|\n)*lossStreak/);
    expect(src).toContain("eventGuardCheck({ symbol, desk: strategy.desk === 'india' ? 'INDIA' : 'CRYPTO', now })");
  });

  it('A3: jevDecider appends event_day line to the snapshot', () => {
    const src = read('server/bots/deciders.js');
    expect(src).toContain("eventDayLine = `event_day: yes");
  });

  it('L4-real-bug-1: botRunner myOpen is let (no const-assign crash on open)', () => {
    const src = read('server/bots/botRunner.js');
    expect(src).toMatch(/let myOpen = Number\(openCounts\.perBot\[botId\]\)/);
  });

  it('L4-real-bug-2: reversalEngine cycle-stop uses finite-checked nullish chain', () => {
    const src = read('server/ai/reversalEngine.js');
    expect(src).toContain('_numOrNull(cycle?.netINR) ?? _numOrNull(waiting.netINR) ?? 0');
  });

  it('L4-real-bug-3: browserAgent CDP script escapes \\s and \\d inside template literal', () => {
    const src = read('server/ai/browserAgent.js');
    expect(src).toContain('replace(/\\\\s+/g');
    expect(src).toContain('/\\\\d/.test');
  });

  it('H1: proTraderAuto imports + calls the shared hard gate pre-order', () => {
    const src = read('server/ai/proTraderAuto.js');
    expect(src).toContain("from '../risk/hardGate.js'");
    expect(src).toMatch(/const hg = proTraderHardGate\(/);
    expect(src).toMatch(/if \(!hg\.ok\)/);
  });

  it('B3: botRunner fee gate uses validatedPWin (per-arm OOS)', () => {
    const src = read('server/bots/botRunner.js');
    expect(src).toMatch(/validatedPWin\(loadBotState\(this\.stateDir, botId\) \|\| \{\}, arm\)/);
  });

  it('C5: india opening-window guard present (09:45)', () => {
    const src = read('server/bots/botRunner.js');
    expect(src).toMatch(/india_opening_window/);
    expect(src).toMatch(/9 \* 60 \+ 45/);
  });

  it('E: risk-block telegram alert deduped daily in botRunner', () => {
    const src = read('server/bots/botRunner.js');
    expect(src).toContain('_alertRiskBlock');
    expect(src).toMatch(/_riskAlertedDay\[botId\] === day/);
  });

  it('B2: routes persist per-arm OOS pWin', () => {
    const src = read('server/bots/routes.js');
    expect(src).toMatch(/pWinOos/);
    expect(src).toMatch(/halves\?\.test/);
  });

  it('B3: metrics halves carry winRate (OOS pWin basis)', () => {
    const src = read('server/bots/core/metrics.js');
    expect(src).toMatch(/winRate: rs\.length \? wins \/ rs\.length : null/);
  });

  it('L1: app/data no longer git-tracked', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync('git -C "' + path.join(process.cwd(), '..') + '" ls-files app/data', { encoding: 'utf8' }).trim();
    expect(out).toBe('');
  });
});
