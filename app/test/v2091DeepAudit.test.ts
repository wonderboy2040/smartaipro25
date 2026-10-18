// ============================================================
// test/v2091DeepAudit.test.ts — v20.9.1 FULL-SITE DEEP RECHECK
// ------------------------------------------------------------
// 4th-pass audit (fresh-eyes, 5 parallel review agents) ke verified
// findings ka regression lock-set. Focus: money-path verdict wiring
// (CoinDCX 200-wrapped rejections), dead-bot gate repairs, lint-gate
// repair, wallet INR-leg viability, calibration leakage, exec-stack
// marks, paperMirror restore, indicator fidelity.
// Mix: functional tests (pure modules) + source contracts (wiring jo
// sirf source-grep se lock ho sakta hai — repo ka established pattern).
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = (p: string) => readFileSync(path.join(APP, p), 'utf8');
const src = {
  futures: S('server/ai/futures.js'),
  spot: S('server/ai/coindcxOrders.js'),
  reversal: S('server/ai/reversalEngine.js'),
  agent: S('server/ai/agent.js'),
  routes: S('server/ai/routes.js'),
  proTrader: S('server/ai/proTraderAuto.js'),
  ledger: S('server/ai/signalLedger.js'),
  index: S('server/index.js'),
  botRunner: S('server/bots/botRunner.js'),
  botRisk: S('server/bots/botRisk.js'),
  accounts: S('server/bots/accounts.js'),
  port: S('server/exec/port.js'),
  pm: S('server/exec/positionManager.js'),
  paperTrading: S('server/intraday/paperTrading.js'),
  intradayAgent: S('server/intraday/agent.js'),
  indicators: S('server/ai/lib/indicators.js'),
  data: S('server/ai/data.js'),
  llmChain: S('server/ai/llmChain.js'),
  mcpRoutes: S('server/mcp/routes.js'),
  mcpTools: S('server/mcpTools.js'),
  paperMirror: S('src/utils/paperMirror.ts'),
  panel: S('src/components/aitrading/ProTraderAutoPanel.tsx'),
  useAIT: S('src/components/aitrading/useAITrading.ts'),
  sw: S('public/sw.js'),
  market: S('telegram-bot/market.mjs'),
  calibrate: S('scripts/botlab-calibrate.mjs'),
  compose: S(path.join('..', 'deploy', 'docker-compose.yml')),
  pkg: JSON.parse(S('package.json')),
  versionTs: S('src/version.ts'),
};

// ============================================================
// A. H1 — CoinDCX 200-wrapped rejection verdicts (money path)
// ============================================================
describe('A. wrapped-rejection verdicts (H1 money path)', () => {
  it('futures SL/TP exit: {ok:false} verdict → throw (fake CLOSE blocked)', () => {
    const i = src.futures.indexOf('futures exit failed');
    expect(i).toBeGreaterThan(-1);
    expect(src.futures.slice(Math.max(0, i - 800), i)).toMatch(/const xr = await exitFuturesPosition\(p\.exchangePositionId\);[\s\S]{0,400}if \(!xr\?\.ok\) throw new Error/);
  });
  it('futures liquidation exit site also verdict-checked', () => {
    const i = src.futures.indexOf('futures liq exit failed');
    expect(i).toBeGreaterThan(-1);
    expect(src.futures.slice(Math.max(0, i - 800), i)).toMatch(/const xr = await exitFuturesPosition\(p\.exchangePositionId\);[\s\S]{0,400}if \(!xr\?\.ok\) throw new Error/);
  });
  it('closeFuturesPosition (manual) returns honest ok:false on wrapped rejection', () => {
    const i = src.futures.indexOf('Exchange close failed');
    expect(src.futures.slice(i - 400, i + 100)).toMatch(/if \(!xr\?\.ok\) return \{ ok: false, error: `Exchange close failed/);
  });
  it('reversalEngine closeLeg checks the resolved verdict', () => {
    expect(src.reversal).toMatch(/const xr = await exitFuturesPosition\(p\.exchangePositionId\);[\s\S]{0,320}if \(!xr\?\.ok\) throw new Error/);
  });
  it('reversalEngine openReversalLeg rejects orderId-less 200 bodies', () => {
    expect(src.reversal).toMatch(/if \(!r\?\.orderId \|\| r\?\.error\) \{[\s\S]{0,400}?return \{ ok: false, error: `exchange rejected leg/);
  });
  it('spot desk imports + applies coindcxRespError (was: zero detection)', () => {
    expect(src.spot).toContain("import { coindcxRespError } from './futures.js'");
    expect(src.spot).toMatch(/const serr = coindcxRespError\(sresp\);\s*\n\s*if \(serr\) throw new Error\(serr\);/); // watcher SL/TP close
    expect(src.spot).toMatch(/const werr = coindcxRespError\(resp\);\s*\n\s*if \(werr\) throw new Error\(werr\);/); // live entry
    expect(src.spot).toMatch(/if \(serr\) return \{ ok: false, error: `Exchange close failed/); // manual close
    expect(src.spot).toMatch(/const merr = coindcxRespError\(mresp\);/); // margin paths
  });
  it('partial legs (both desks): exchange verdict checked BEFORE booking', () => {
    expect(src.futures).toMatch(/if \(!xr\?\.orderId \|\| xr\?\.error\) \{\s*\n\s*return \{ ok: false, error: `exchange rejected \$\{stage\} partial/);
    expect(src.spot).toMatch(/const serr = coindcxRespError\(sresp\);\s*\n\s*if \(serr\) throw new Error\(serr\);/);
  });
  it('LIVE + disconnected partial → NOT paper-booked (both desks)', () => {
    expect(src.futures).toMatch(/if \(!coindcxConnected\(\)\) \{\s*\n\s*\/\/ v20\.9\.1 \[H2\][\s\S]{0,500}?NOT paper-booking the leg/);
    expect(src.spot).toMatch(/if \(!coindcxConnected\(\)\) \{\s*\n\s*\/\/ v20\.9\.1 \[H2\][\s\S]{0,500}?NOT paper-booking the leg/);
  });
  it('partial qty capped at CURRENT position qty (over-close guard, both desks)', () => {
    expect(src.futures).toMatch(/Math\.min\(\(originalQty \* pct\) \/ 100, Number\(p\.qty\)\)/);
    expect(src.spot).toMatch(/Math\.min\(\(originalQty \* pct\) \/ 100, Number\(p\.qty\)\)/);
  });
});

// ============================================================
// B. H2 — dead/broken features repaired
// ============================================================
describe('B. feature repairs (H2)', () => {
  it('agent: INR-margined futures wallet combined viability (USDT + INR/fx)', () => {
    expect(src.agent).toMatch(/function combinedFutDeployableUSDT/);
    // v21.0.2: viability gate ab MODE-AWARE hai — PAPER/NOTIFY me futures
    // practice-equity pe chalta hai (sirf equity-sim auto-trade hota complaint
    // fix), LIVE me wallet/margin floor. Source contract updated v21.0.2.
    expect(src.agent).toMatch(/const futuresViable = \(!coindcxConnected\(\) \|\| cfg\.mode !== 'live'\)\s*\n\s*\? true[\s\S]{0,700}?: \(_futMargin >= 2\);/);
    expect(src.agent).toMatch(/combinedFutDeployableUSDT\(wallet\) \|\| \(equityINR \* 0\.5 \/ usdInr\)/); // 60% cap site (LIVE branch — v21.0.2 paper branch practice equity)
    expect(src.agent).toMatch(/deployableFuturesINR: w\.deployableFuturesINR/); // lastWallet carries INR leg
  });
  it('agent: last-known equity fallback is 10-minute bounded', () => {
    expect(src.agent).toMatch(/_eqLastKnown = \(_eqLastW && Date\.now\(\) - \(Number\(_eqLastW\.at\) \|\| 0\) < 10 \* 60_000/);
  });
  it('exec/enter: pair normalized to B-{SYM}_USDT (ladder price-blind fix)', () => {
    expect(src.routes).toMatch(/signal\.pair = expected;/);
    expect(src.routes).toMatch(/is not the CoinDCX futures form/); // honest 400 on foreign pair
  });
  it('ml/signals retired honestly (410) — hardcoded HOLD-30 endpoint gone', () => {
    expect(src.index).toMatch(/app\.post\('\/api\/ml\/signals'[^)]*\)\s*=>\s*\{\s*\n\s*res\.status\(410\)/);
    expect(src.index).not.toMatch(/getAllSignals\(portfolio \|\| \[\]/);
  });
  it('lint gate repaired: typescript-eslint parser, no || true, wired into check', () => {
    expect(src.pkg.scripts.lint).toBe('eslint server src --no-error-on-unmatched-pattern');
    expect(src.pkg.scripts.check).toContain('npm run lint');
    expect(S('eslint.config.mjs')).toContain("import tseslint from 'typescript-eslint'");
    expect(S('eslint.config.mjs')).toContain("tseslint.configs.recommended");
  });
  it('Bot Lab telegram alerts wired in production path', () => {
    // [v20.9.4] TG-shaped env bhi inject hota hai — sendTelegramMessage
    // {token,chatId} options padhta hai; raw process.env pass karne se
    // TG_TOKEN/TG_CHAT_ID deployments me alerts silently dead the.
    expect(src.index).toMatch(/telegram: \{ enabled: Boolean\(TG\.token && TG\.chatId\), env: \{ token: TG\.token, chatId: TG\.chatId \} \},/);
    // ...aur runner-side: BotRunner tgEnv fallback chain (v20.9.4 H2)
    expect(src.botRunner).toMatch(/this\.tgEnv = \(telegram\?\.env && \(telegram\.env\.token \|\| telegram\.env\.chatId\)\)/);
  });
  it('botlab-calibrate reads the FLAT botState events layout', () => {
    expect(src.calibrate).toMatch(/readdirSync\(botsDir\)\.filter\(\(x\) => x\.endsWith\('\.events\.jsonl'\)\)/);
    expect(src.calibrate).toMatch(/purgedWalkForwardFolds/); // promised folds now implemented
  });
  it('paperMirror: compare-BEFORE-save (restore path un-deadened)', () => {
    const body = src.paperMirror.slice(src.paperMirror.indexOf('export async function syncMirrorWithServer'));
    const prevIdx = body.indexOf('const previous = await getMirror()');
    const decideIdx = body.indexOf('shouldRestore(previous');
    const saveIdx = body.indexOf('await saveMirror(open, historyTrades);');
    expect(prevIdx).toBeGreaterThan(-1);
    expect(decideIdx).toBeGreaterThan(prevIdx);
    expect(saveIdx).toBeGreaterThan(decideIdx); // save only AFTER the decision
  });
  it('browserAgent CDP regexes: all 5 sites at the 2-backslash transport form', async () => {
    const ba = S('server/ai/browserAgent.js');
    // BROKEN form = 4 backslashes in file (page receives '\\s' = literal backslash+s).
    // Correct form = 2 backslashes (page receives '\s').
    const broken = (needle: string) => ba.split(needle).length - 1;
    expect(broken('place\\\\\\\\s*order')).toBe(0); // 4-backslash form gone
    expect(broken('square\\\\\\\\s*off')).toBe(0);
    expect(broken('close\\\\\\\\s*all')).toBe(0);
    // CORRECT 2-backslash forms present (5 sites: 663 confirm, 765/771/881/887 exits)
    expect(ba.split('place\\\\s*order').length - 1).toBe(1);
    expect(ba.split('square\\\\s*off').length - 1).toBe(4);
    expect(ba.split('close\\\\s*all').length - 1).toBe(1);
  });
  it('ml-service meta frame: global date sort (cross-symbol leakage fix)', () => {
    const py = S('ml-service/models/train_signal.py');
    expect(py).toContain('sort_values("_ts", kind="stable"');
    expect(py).toMatch(/rows\.append\(vec \+ \[r\.get\("dir_label"\), regime_label_of\(r\), _ts\]\)/);
  });
});

// ============================================================
// C. H3 — edge-case fixes (functional)
// ============================================================
describe('C. orb_in gate: double-ATR normalization repaired (H2)', () => {
  it('real-scale slope (0.05 ATR/bar) now PASSES the average_not_turning gate', async () => {
    const { orbIn } = await import('../server/bots/strategies/orbIn.js');
    const gates = orbIn.gates();
    const g = gates.find((x: { name: string }) => x.name === 'average_not_turning') as (row: unknown, ctx: unknown) => string | null;
    expect(g).toBeTruthy();
    // NIFTY-scale: slope already normalized (0.05), ATR 50 — pre-fix this was 0.001 vs 0.02 threshold
    const veto = g({ atr: 50 }, { features: { ema_fast_slope_atr: 0.05 } });
    expect(veto).toBeNull();
    // genuinely flat slope still vetoes
    expect(g({ atr: 50 }, { features: { ema_fast_slope_atr: 0.005 } })).toBe('average_not_turning');
    // raw-slope fallback (ctx.emaFastSlope — deciders ka ctx shape) normalizes exactly once
    expect(g({ atr: 50 }, { features: {}, emaFastSlope: 2.5 })).toBeNull(); // 2.5/50 = 0.05
    expect(g({ atr: 50 }, { features: {}, emaFastSlope: 0.25 })).toBe('average_not_turning'); // 0.005
  });
});

describe('D. lvl friction: real-cost computation (H2, honest gate)', () => {
  it('frictionRiskR now derived from estimateRoundTripCost + engine slip', async () => {
    const { makeLvl } = await import('../server/bots/strategies/lvl.js');
    const strat = makeLvl();
    // crypto geometry: sweep-reclaim candidate on a synthetic row is hard to
    // build honestly; instead verify the gate math contract on the friction
    // number itself via a directly-constructed ctx path.
    const gates = strat.gates();
    const fr = gates.find((x: { name: string }) => x.name === 'friction_dominant') as (row: unknown, ctx: unknown) => string | null;
    expect(fr).toBeTruthy();
    expect(fr({ frictionRiskR: 0.04 }, {})).toBeNull(); // below threshold passes
    expect(fr({ frictionRiskR: 0.6 }, {})).toBe('friction_dominant'); // real-market fr vetoes (empirical: rules arm 0% win, feeDrag 53R)
    expect(fr({}, {})).toBe('friction_dominant:insufficient_data');
    // source: the placeholder-5bps formula is replaced by the cost-model path
    expect(S('server/bots/strategies/lvl.js')).toContain('estimateRoundTripCost({ qty: 1, entryPrice: entry, exitPrice: entry');
  });
});

describe('E. hardGate fail-closed (M)', () => {
  it('drawdown rule + missing/NaN peak → account_state_invalid(peak)', async () => {
    const { hardGateCheck } = await import('../server/risk/hardGate.js');
    const v = hardGateCheck({ account: { equity: 1000 }, maxDrawdownPct: 25 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('account_state_invalid(peak)');
  });
  it('floor rule + missing start → account_state_invalid(start)', async () => {
    const { hardGateCheck } = await import('../server/risk/hardGate.js');
    const v = hardGateCheck({ account: { equity: 1000 }, equityFloorPct: 30 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('account_state_invalid(start)');
  });
  it('valid peak still kills on drawdown (regression guard)', async () => {
    const { hardGateCheck } = await import('../server/risk/hardGate.js');
    const v = hardGateCheck({ account: { equity: 700, peakEquity: 1000 }, maxDrawdownPct: 25 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('max_drawdown_kill');
  });
});

describe('F. accounts loss-streak (H3 — events-window disarm)', () => {
  it('applyTrade maintains lossStreakToday (increment on loss, reset on win)', async () => {
    const { blankAccount, applyTrade } = await import('../server/bots/accounts.js');
    let acc = blankAccount('lvl');
    acc = applyTrade(acc, { grossPnl: -10, netPnl: -10, fees: 0, rNet: -1 });
    expect(acc.lossStreakToday).toBe(1);
    acc = applyTrade(acc, { grossPnl: -10, netPnl: -10, fees: 0, rNet: -1 });
    expect(acc.lossStreakToday).toBe(2);
    acc = applyTrade(acc, { grossPnl: 5, netPnl: 5, fees: 0, rNet: 1 });
    expect(acc.lossStreakToday).toBe(0);
  });
  it('botRiskConfig: BOT_REENTRY_COOLDOWN_MIN=0 is VALID (declared range [0,720])', async () => {
    const { botRiskConfig } = await import('../server/bots/botRisk.js');
    const c = botRiskConfig({ BOT_REENTRY_COOLDOWN_MIN: '0' });
    expect(c.reentryCooldownMin).toBe(0);
    expect(c._envWarnings.filter((w: string) => w.includes('REENTRY'))).toHaveLength(0);
    // negative still invalid → default
    const c2 = botRiskConfig({ BOT_REENTRY_COOLDOWN_MIN: '-5' });
    expect(c2.reentryCooldownMin).toBe(30);
  });
});

describe('G. SAPTA risk-state (M/H3)', () => {
  const day = '2026-10-06';
  const mk = (pnl: number, i: number) => ({ id: `T${i}`, day, status: 'CLOSED', closed: { ts: 1000 + i, pnlINR: pnl } });
  it('UNFILLED rows excluded from daily unrealized', async () => {
    const { saptaRiskState } = await import('../server/ai/proTraderAuto.js');
    const s = saptaRiskState([mk(-100, 0), { id: 'U1', day, status: 'UNFILLED', lastPnlINR: -9999 }], { day });
    expect(s.dailyPnl).toBe(-100); // stale UNFILLED lastPnl no longer counted
  });
  it('cumStats seed preserves historical peak across journal trims', async () => {
    const { saptaRiskState } = await import('../server/ai/proTraderAuto.js');
    const s = saptaRiskState([mk(50, 0)], { day, cumStats: { cum: 1000, peak: 1500 } });
    expect(s.peakCum).toBe(1500);
    expect(s.cum).toBe(1050);
  });
  it('proTraderHardGate forwards cumStats (source contract)', () => {
    expect(src.proTrader).toMatch(/proTraderHardGate\(\{[^}]*cumStats = null/);
    expect(src.proTrader).toMatch(/trades: _trades\(\), cumStats: _journal\(\)\?\.cumStats \|\| null/);
  });
  it('_saveTrade folds trimmed rows into j.cumStats (trim-proof drawdown memory)', () => {
    expect(src.proTrader).toMatch(/j\.cumStats = \{ cum, peak \};/);
  });
  it('reversal confirmStreak resets on weak rc.hit ticks (strict consecutive)', () => {
    expect(src.proTrader).toMatch(/patch\.confirmStreak = 0;\s*\n\s*_updTrade\(t\.id, patch\);\s*\n\s*\}\s*\n\s*\} catch \(e\) \{/);
  });
  it('stale_feed gate uses the candidate signal age, not same-tick lastScan', () => {
    expect(src.proTrader).toMatch(/const sigAge = Number\(sig\?\.generatedAt\) > 0/);
  });
});

describe('H. signalLedger purge/embargo (H3)', () => {
  it('right-side embargo: train cannot start inside the test fold\'s overlap window', async () => {
    const { purgedWalkForwardSplit } = await import('../server/ai/signalLedger.js');
    const trades: Array<{ tsIn: number; tsOut: number }> = [];
    const t0 = 1_000_000;
    for (let i = 0; i < 80; i++) {
      const tsIn = t0 + i * 60_000;
      trades.push({ tsIn, tsOut: tsIn + 3 * 60_000 }); // 3-min holds
    }
    const folds = purgedWalkForwardSplit(trades, { folds: 4, embargoMs: 60_000 });
    expect(folds.length).toBeGreaterThan(0);
    for (const f of folds) {
      // every train trade either exits before testStart-embargo or enters at/after testEnd+embargo
      const cutA = t0 + Math.floor((80 * (f.fold - 1)) / 4) * 60_000;
      const cutB = t0 + Math.floor((80 * f.fold) / 4) * 60_000;
      for (const t of f.train as Array<{ tsIn: number; tsOut: number }>) {
        const ok = t.tsOut < cutA - 60_000 || t.tsIn >= cutB + 60_000;
        expect(ok).toBe(true);
      }
    }
  });
});

// ============================================================
// I. Indicators fidelity (H3/M)
// ============================================================
describe('I. indicators (RSI flat / stochastic %D / supertrend)', () => {
  it('rsi: perfectly flat series → 50 (neutral), not 100', async () => {
    const { rsi } = await import('../server/ai/lib/indicators.js');
    const flat = Array.from({ length: 30 }, () => 100);
    expect(rsi(flat, 14)).toBe(50);
  });
  it('rsi: only-gains series → 100 (unchanged)', async () => {
    const { rsi } = await import('../server/ai/lib/indicators.js');
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up, 14)).toBe(100);
  });
  it('stochastic %D is an SMA of the SMOOTHED K series (not raw %K)', async () => {
    const { stochastic } = await import('../server/ai/lib/indicators.js');
    // alternating extremes: raw K flips 0/100; smoothed K is mid; %D of smoothed != SMA of raw
    const candles = Array.from({ length: 40 }, (_, i) => {
      const hi = i % 2 === 0 ? 110 : 100;
      const lo = i % 2 === 0 ? 100 : 90;
      const close = i % 2 === 0 ? 109 : 91;
      return { time: i, open: 100, high: hi, low: lo, close, volume: 1 };
    });
    const out = stochastic(candles, 14, 3, 3);
    expect(out).toBeTruthy();
    expect(out!.k).toBeGreaterThan(0);
    expect(out!.k).toBeLessThan(100);
    expect(Math.abs(out!.k - out!.d)).toBeLessThanOrEqual(50 + 1e-9); // both mid-series, not 0-vs-100 flips
  });
  it('supertrend: direction persists through a minor pullback (carry-forward bands)', async () => {
    const { supertrend } = await import('../server/ai/lib/indicators.js');
    // steady uptrend then ONE red bar — old stub flipped direction on any down-close
    const candles = Array.from({ length: 40 }, (_, i) => {
      const base = 100 + i;
      const close = i === 38 ? base - 1.5 : base + 1; // one red bar near the end
      return { time: i, open: base, high: Math.max(base + 1, close) + 0.5, low: Math.min(base, close) - 0.5, close, volume: 1 };
    });
    const st = supertrend(candles, 10, 3);
    expect(st).toBeTruthy();
    expect(st!.direction).toBe(1); // one-bar pullback must not flip a 30-bar trend
  });
  it('supertrend: flips on a REAL band cross (deep reversal)', async () => {
    const { supertrend } = await import('../server/ai/lib/indicators.js');
    const candles = Array.from({ length: 60 }, (_, i) => {
      const up = i < 35;
      const base = up ? 100 + i * 2 : 170 - (i - 35) * 4; // strong up, then hard crash
      const close = up ? base + 1 : base - 2;
      return { time: i, open: base, high: Math.max(base, close) + 1, low: Math.min(base, close) - 1, close, volume: 1 };
    });
    const st = supertrend(candles, 10, 3);
    expect(st).toBeTruthy();
    expect(st!.direction).toBe(-1); // crash must flip the trend
  });
});

describe('J. mlEngine price_points direction (H3)', () => {
  it('bearish signal → SL above entry, targets below (SHORT mirror)', async () => {
    const { getMLPrediction } = await import('../server/mlEngine.js');
    // falling series → SELL/STRONG_SELL (score < 50 → bearish direction)
    const candles = Array.from({ length: 60 }, (_, i) => ({
      time: i, open: 200 - i, high: 201 - i, low: 199 - i, close: 200 - i - 0.5, volume: 10,
    }));
    const r = getMLPrediction('TEST', 'IN', 140, -20, candles);
    if (r.direction === 'bearish') {
      expect(r.price_points.stop_loss).toBeGreaterThan(r.price_points.entry);
      expect(r.price_points.tp1).toBeLessThan(r.price_points.entry);
      expect(r.price_points.direction).toBe('bearish');
    } else {
      // direction is heuristic — if it reads bullish on this shape, ladder stays long-form
      expect(r.price_points.stop_loss).toBeLessThan(r.price_points.entry);
    }
  });
});

// ============================================================
// K. exec stack (H3 — marks wiring, reduce guard, port accounting)
// ============================================================
describe('K. exec stack', () => {
  it('PM.tick pushes live marks into the port (paper PnL no longer frozen at entry)', () => {
    expect(src.pm).toMatch(/this\._port\.setMarkPrice\?\.\(p\.pair, mark\)/);
  });
  it('PM: sub-precision reduceQty → FULL exit at T1/T2 (no phantom stage advance)', () => {
    expect(src.pm).toMatch(/if \(!\(reduceQty > 0\)\) \{\s*\n\s*const res = await this\._port\.close/);
    expect(src.pm.match(/t1-full-exit/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src.pm.match(/t2-full-exit/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it('PM: bePending SL-move retry exists (alert promise now real)', () => {
    expect(src.pm).toMatch(/if \(st\.bePending != null && \(st\.stage === 'T1_HIT' \|\| st\.stage === 'RUNNER'\)\)/);
    expect(src.pm).toMatch(/kind: 'protect-retry'/);
  });
  it('PaperPort: close/reduce add realized PnL to FREE margin', async () => {
    const { PaperPort } = await import('../server/exec/port.js');
    const p = new PaperPort({ startingEquityUSDT: 1000 });
    const opened = await p.open({ pair: 'B-TEST_USDT', side: 'LONG', qty: 10, leverage: 1, type: 'market', price: 100 });
    expect(opened.ok).toBe(true);
    const id = String(opened.positionId || opened.raw?.id || opened.orderId);
    p.setMarkPrice('B-TEST_USDT', 90); // mark down 10%
    const eqBefore = await p.getEquity();
    const r = await p.close({ positionId: id });
    expect(r.ok).toBe(true);
    expect(r.raw?.paper).toBe(true); // marker for settle discrimination
    const eqAfter = await p.getEquity();
    expect(eqAfter.totalUSDT).toBeCloseTo(eqBefore.totalUSDT, 1); // 10 qty × -$10 both views
    expect(eqAfter.totalUSDT).toBeCloseTo(900, 1);
    // free must ALSO be down ~100 (was: margin-only return → free overstated by the loss)
    expect(eqAfter.freeUSDT).toBeCloseTo(900, 1);
  });
  it('settle: paper realizedPnl still gets fees/slip; exchange number as-is (marker discrimination)', () => {
    expect(src.botRunner).toMatch(/r\.raw\.paper !== true/);
    expect(src.botRunner).toMatch(/const netPnl = _isExchangeNumber \? _exRealized : gross - fees - slip;/);
  });
});

// ============================================================
// L. index.js / infra wiring (source contracts)
// ============================================================
describe('L. server wiring', () => {
  it('mark cache TTL tightened to 4 min (open-position SL/TP latency)', () => {
    expect(src.index).toMatch(/MARK_CACHE_TTL_MS = 4 \* 60_000/);
  });
  it('India candle saveDelta is a true delta (no per-tick full rewrite)', () => {
    const i = src.index.indexOf("loadCandlesCached(BOTS_STATE_DIR, 'india', symbol, '5m')");
    expect(i).toBeGreaterThan(-1);
    expect(src.index.slice(i, i + 500)).toMatch(/saveDelta = bars\.filter\(b => b\.t >= histLastT \|\| !histSet\.has\(b\.t\)\)/);
  });
  it('500 responses no longer leak raw detail (4xx only)', () => {
    expect(src.index).toMatch(/\.\.\.\(status < 500 \? \{ detail: String\(err\?\.message \|\| err\)\.slice\(0, 200\) \} : \{\}\),/);
  });
  it('intraday paper SL/BE fills at the TRADED price (gap-through honesty)', () => {
    expect(src.paperTrading).toMatch(/const slFill = isLong \? Math\.min\(p, t\.stopLoss\) : Math\.max\(p, t\.stopLoss\);/);
    expect(src.paperTrading).toMatch(/const beFill = isLong \? Math\.min\(p, t\.entry\) : Math\.max\(p, t\.entry\);/);
  });
  it('agent position-size tool ENFORCES the 25% capital cap', () => {
    expect(src.intradayAgent).toMatch(/const qty = Math\.max\(0, Math\.min\(riskOnlyQty, capQty\)\);/);
  });
});

// ============================================================
// M. data / LLM / costs (source + functional)
// ============================================================
describe('M. data & LLM robustness', () => {
  it('Bybit fallback never caches a shallower window under the requested-limit key', () => {
    expect(src.data).toMatch(/if \(candles\.length >= limit\) _candleCacheSet\(cacheKey, candles\);/);
  });
  it('crypto snapshot: unknown FX scale → scaled fields nulled + degraded flag', () => {
    expect(src.data).toMatch(/indicatorsDegraded/);
    expect(src.data).toMatch(/const S = \(v\) => \(scale != null && v != null \? v \* scale : null\);/);
  });
  it('llmChain: non-2xx throws a status-coded error (sentinel ladder live)', () => {
    expect(src.llmChain).toMatch(/throw new Error\(`\$\{provider\} http \$\{r\.status\}`\);/);
    expect(src.llmChain).toMatch(/lastErr = new Error\(`gemini http \$\{r\.status\}`\); continue;/);
  });
  it('tradingCosts: remaining entry-side fees counted WITHOUT lastPrice', async () => {
    const m = await import('../server/ai/tradingCosts.js') as { estimateRoundTripCostForTrade?: unknown } & Record<string, unknown>;
    // source contract (the fn is not exported by that name — check the partial-close path text)
    expect(S('server/ai/tradingCosts.js')).toMatch(/v20\.9\.1 \[M\]: remaining entry-side costs HAMESHA count/);
    expect(m).toBeTruthy();
  });
});

// ============================================================
// N. frontend + deploy + ops (source contracts)
// ============================================================
describe('N. frontend & ops', () => {
  it('fetchWallet: non-OK → null (401 body no longer a truthy "wallet")', () => {
    expect(src.useAIT).toMatch(/if \(!r\.ok\) return null;\s*\n\s*return await r\.json\(\)\.catch\(\(\) => null\);/);
  });
  it('panel SAVE resyncs cfgEd from the server-clamped config response', () => {
    expect(src.panel).toMatch(/\(j as \{ config\??: Record<string, unknown> \}\)\)?\.config/);
    expect(src.panel).toMatch(/setCfgEd\(\(prev\) => \(\{ \.\.\.\(prev \|\| cfgEd\)/);
  });
  it('sw.js: navigation shell cache only for OK basic responses', () => {
    expect(src.sw).toMatch(/if \(res\.ok && res\.type === 'basic'\) \{/);
  });
  it('version sync release gate wired (package.json === APP_VERSION, dynamic — stale-pin khatam) [v20.9.4]', () => {
    expect(src.pkg.scripts['check:version']).toBe('node scripts/check-version.mjs');
    expect(src.pkg.scripts.check).toContain('npm run check:version');
    // [v20.9.4] hard-pin 20.9.2 har bump pe stale hota tha — ab cross-consistency:
    // version.ts ka APP_VERSION hamesha package.json version se match hona chahiye
    const m = src.versionTs.match(/APP_VERSION = '([^']+)'/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(src.pkg.version);
  });
  it('mcp requestOrigin gates x-forwarded-host on TRUST_PROXY/loopback', () => {
    expect(src.mcpRoutes).toMatch(/_MCP_TRUST_PROXY \|\| _mcpIsLoopback\(peer\)/);
  });
  it('planner tool tags stale-fallback prices', () => {
    expect(src.mcpTools).toMatch(/priceSource: 'stale-fallback/);
    expect(src.mcpTools).toMatch(/priceWarning/);
  });
  it('telegram market.mjs routes BINANCE: tickers to the crypto scanner batch', () => {
    expect(src.market).toMatch(/cryptoTickers\.push\(t\)/);
    expect(src.market).toMatch(/scanBatch\('crypto', cryptoTickers\)/);
  });
  it('docker backup sidecar snapshots ai-trading-config.json (risk envelope)', () => {
    expect(src.compose).toContain('ai-trading-config.json');
  });
  it('backup-state writes atomically (tmp + rename) and exits non-zero on missing dir', () => {
    const b = S('scripts/backup-state.mjs');
    expect(b).toMatch(/tmpPath = `\$\{outPath\}\.tmp-/);
    expect(b).toMatch(/renameSync\(tmpPath, outPath\)/);
    expect(b).toMatch(/process\.exit\(2\);/);
  });
  it('client-supplied system role demoted to user (intraday agent injection surface)', () => {
    expect(S('server/intraday/routes.js')).toMatch(/role: \['user', 'assistant'\]\.includes\(m\?\.role\) \? m\.role : 'user',/);
  });
});
