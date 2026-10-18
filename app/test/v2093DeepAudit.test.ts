// ============================================================
// test/v2093DeepAudit.test.ts — v20.9.3 FULL-SITE WORKING-FLOW
// RECHECK (5th pass) — regression locks for every fix
// ------------------------------------------------------------
// The 5 parallel flow-trace review agents found ~30 verified
// defects; this file locks the fixes:
//   A. UCV-A1 CURRENCY-DOMAIN fix (H1): a USDT tick vs INR candles
//      (or mirror) is a ~±98% "velocity" — the old check 8 injected a
//      constant ±8 score skew on EVERY futures verdict (and the
//      mirror on Binance-fallback hosts). Locked: |tickPct| > 20 →
//      N/A row + ZERO score contribution.
//   B. UC-REJECTED exec veto (H2): evaluateExecutionGate must refuse
//      a direction the realtime ultrafast chart rejected — even when
//      a stale/unpatched signal object still carries STRONG/80+.
//   C. Spot-desk MARGIN LIQUIDATION exit verdict-check (H1): the one
//      money call-site that still trusted HTTP-200-wrapped
//      rejections (fake LIQUIDATED booking while the real leveraged
//      position stayed open, stop-less).
//   D. INDIA live-trade lifecycle (H2): fill verification reads the
//      DHAN positions desk, and the PLACED→UNFILLED TTL cannot
//      blind-retire a filled INDIA position.
//   E. Cross-engine double-order lock (H2): SAPTA ↔ auto-agent read
//      each other's journals before ordering.
//   F. Deep-path UC gate parity (H2) + board UC widening (M) +
//      winProb recompute (L).
//   G. exec-enter journal row + PM boot hydration (M): a restart no
//      longer orphans protection-first entries off the ladder.
//   H. Bot desk: peak fail-closed, verdict-aware telegram, per-slot
//      knob, shared-port per-position owner.
//   I. Ops: backup-state default dir, BACKUP_STATE_ON_BOOT wiring,
//      cancel verdict-checks, expertPicks structure factor.
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeUltrafastChart } from '../server/ai/ultrafastVerifier.js';
import { evaluateExecutionGate } from '../server/ai/ensemble.js';
import { botRiskCheck, botRiskConfig } from '../server/bots/botRisk.js';
import { PositionManager } from '../server/exec/positionManager.js';
import { PaperPort } from '../server/exec/port.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const S_VER = join(ROOT, 'server/ai/ultrafastVerifier.js');
const S_SIG = join(ROOT, 'server/ai/signals.js');
const S_ORD = join(ROOT, 'server/ai/coindcxOrders.js');
const S_PTA = join(ROOT, 'server/ai/proTraderAuto.js');
const S_AGT = join(ROOT, 'server/ai/agent.js');
const S_FUT = join(ROOT, 'server/ai/futures.js');
const S_RT = join(ROOT, 'server/ai/routes.js');
const S_EXP = join(ROOT, 'server/ai/expertPicks.js');
const S_RUN = join(ROOT, 'server/bots/botRunner.js');
const S_IDX = join(ROOT, 'server/index.js');
const S_SUP = join(ROOT, 'server/supervisor.js');
const S_BKP = join(ROOT, 'scripts/backup-state.mjs');

// ---------- candle helpers (same shape as ultrafastVerifier.test.ts) ----------
let T0 = 1_700_000_000_000;
function bar(open: number, close: number, vol = 120) {
  T0 += 60_000;
  return {
    time: T0, open, close,
    high: Math.max(open, close) + 0.12, low: Math.min(open, close) - 0.12,
    volume: vol,
  };
}
function rising1m(n = 60, step = 0.55) {
  const out: ReturnType<typeof bar>[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) { out.push(bar(p, p + step)); p += step; }
  return out;
}

// ============================================================
// A. UCV-A1 currency-domain guard (H1)
// ============================================================
describe('v20.9.3 A — ultrafast verifier currency-domain guard', () => {
  it('a USDT-scale tick vs INR-scale candles is skipped N/A (no ±8 skew)', () => {
    const inrCandles = rising1m(60, 0.55).map(c => ({ ...c, open: c.open * 8_400_000, close: c.close * 8_400_000, high: c.high * 8_400_000, low: c.low * 8_400_000 }));
    const last = inrCandles[inrCandles.length - 1].close; // ~INR scale
    const base = analyzeUltrafastChart({ candles1m: inrCandles });
    const mismatch = analyzeUltrafastChart({ candles1m: inrCandles, liveTick: { price: last / 84, time: Date.now() } }); // USDT scale ≈ −98.8%
    const tickRow = mismatch.checks.find((c: { id: string }) => c.id === 'tickVelocity');
    expect(tickRow?.status).toBe('N/A');
    expect(String(tickRow?.detail)).toMatch(/denomination mismatch/i);
    // ZERO score contribution: identical microScore to the no-tick run.
    expect(mismatch.microScore).toBe(base.microScore);
  });

  it('a same-domain live tick still scores BULL/BEAR velocity', () => {
    const c1 = rising1m(60, 0.55);
    const last = c1[c1.length - 1].close;
    const a = analyzeUltrafastChart({ candles1m: c1, liveTick: { price: last * 1.004, time: Date.now() } });
    const tickRow = a.checks.find((c: { id: string }) => c.id === 'tickVelocity');
    expect(tickRow?.status).toBe('BULL');
    expect(a.microScore).toBeGreaterThan(0);
  });

  it('the FUTURES desk fetches USDT-domain futures candles (source-lock)', () => {
    const s = src('server/ai/ultrafastVerifier.js');
    expect(s).toMatch(/import \{ fetchFuturesCandles, futuresPairFor \} from '\.\/futures\.js'/);
    expect(s).toMatch(/market === 'FUTURES'[\s\S]{0,220}fetchFuturesCandles\(futuresPairFor\(base\)/);
    // the defensive guard is in the check itself
    expect(s).toMatch(/Math\.abs\(tickPct\) > 20/);
  });
});

// ============================================================
// B. UC-REJECTED exec gauntlet veto (H2)
// ============================================================
describe('v20.9.3 B — evaluateExecutionGate refuses a UC-REJECTED direction', () => {
  const mk = (over: Record<string, unknown> = {}) => ({
    side: 'LONG', market: 'CRYPTO', grade: 'STRONG', confidence: 78, agreement: 0.8,
    generatedAt: Date.now(), plan: { riskPct: 2, entry: 100, stopLoss: 98, target1: 104, target2: 108, rewardRisk: 2 },
    ...over,
  });
  it('a STRONG signal carrying ultrafast REJECTED is refused (stale/unpatched objects cannot order)', () => {
    const g = evaluateExecutionGate(mk({ ultrafast: { verdict: 'REJECTED', microDirection: 'DOWN', score: -42 } }), { side: 'LONG' });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/UCV-A1 REJECTED/i);
  });
  it('the bare ucRejected flag (deep-path stamp) also refuses', () => {
    const g = evaluateExecutionGate(mk({ ucRejected: true }), { side: 'LONG' });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/UCV-A1 REJECTED/i);
  });
  it('PENDING and CONFIRMED verdicts pass through (honest degrade intact)', () => {
    for (const v of ['PENDING', 'CONFIRMED']) {
      const g = evaluateExecutionGate(mk({ ultrafast: { verdict: v, microDirection: 'UP', score: 30 } }), { side: 'LONG' });
      expect(g.ok).toBe(true);
    }
  });
  it('practice (PAPER) clicks are refused too — rehearsing a rejected direction is worse than useless', () => {
    const g = evaluateExecutionGate(mk({ ultrafast: { verdict: 'REJECTED', microDirection: 'DOWN', score: -42 } }), { side: 'LONG', practice: true, requireStrong: false });
    expect(g.ok).toBe(false);
  });
});

// ============================================================
// C. Spot margin liquidation verdict-check (H1)
// ============================================================
describe('v20.9.3 C — margin liquidation exit is verdict-checked', () => {
  it('the spot-desk liq exit throws on a 200-wrapped rejection before booking CLOSED (source-lock)', () => {
    const s = readFileSync(S_ORD, 'utf8');
    // `const resp =` prefix is UNIQUE to the v20.9.3 verdict-checked liq site
    const i = s.indexOf("const resp = await coindcxPrivate('/exchange/v1/margin/orders/exit_positions'");
    expect(i).toBeGreaterThan(0);
    const around = s.slice(i, i + 420);
    expect(around).toMatch(/coindcxRespError\(resp\)/);
    expect(around).toMatch(/if \(lerr\) throw new Error\(lerr\)/);
  });
  it('cancel + cancelAll are verdict-checked too (source-lock)', () => {
    const s = readFileSync(S_ORD, 'utf8');
    for (const path of ['orders/cancel\'', 'orders/cancel_all']) {
      const i = s.indexOf(path);
      expect(i).toBeGreaterThan(0);
      expect(s.slice(i, i + 700)).toMatch(/coindcxRespError/);
    }
  });
});

// ============================================================
// D. INDIA live-trade lifecycle (H2)
// ============================================================
describe('v20.9.3 D — INDIA live trades are verified, not blind-retired', () => {
  it('dhanReadPositions is imported and the desk-aware reader routes INDIA to Dhan (source-lock)', () => {
    const s = readFileSync(S_PTA, 'utf8');
    expect(s).toMatch(/dhanReadPositions,/);
    expect(s).toMatch(/market === 'INDIA' \? await dhanReadPositions\(\) : await cxReadPositions\(\)/);
  });
  it('fill-verify blocks no longer exclude INDIA (source-lock)', () => {
    const s = readFileSync(S_PTA, 'utf8');
    expect(s).not.toMatch(/t\.mode === 'live' && market !== 'INDIA'\s*\r?\n\s*&& Date\.now\(\) - \(t\.fillCheckedAt/);
    expect(s).not.toMatch(/t\.status === 'PLACED' && t\.mode === 'live' && market !== 'INDIA'/);
  });
  it('PLACED→UNFILLED TTL for INDIA live requires a verified positions read (source-lock)', () => {
    const s = readFileSync(S_PTA, 'utf8');
    expect(s).toMatch(/indiaLiveNeedsCheck = market === 'INDIA' && t\.mode === 'live'/);
    expect(s).toMatch(/!indiaLiveNeedsCheck \|\| t\.fillCheckedAt \|\| placedAgeMs > PLACED_TTL_MIN \* 3 \* 60_000/);
  });
});

// ============================================================
// E. Cross-engine double-order lock (H2)
// ============================================================
describe('v20.9.3 E — SAPTA ↔ auto-agent mutual exclusion', () => {
  it('SAPTA _tryEntry refuses pairs the shared journal holds OPEN/UNKNOWN (source-lock)', () => {
    const s = readFileSync(S_PTA, 'utf8');
    expect(s).toMatch(/ai-trading-journal\.json', \{ entries: \[\], positions: \[\] \}\)/);
    expect(s).toMatch(/cross-engine lock: auto-agent already on/);
  });
  it('the agent candidate loop skips SAPTA-owned open/blocked pairs (source-lock)', () => {
    const s = readFileSync(S_AGT, 'utf8');
    expect(s).toMatch(/protrader-auto-journal\.json', \{ trades: \[\] \}\)/);
    expect(s).toMatch(/'MONITORING', 'PLACED', 'CLOSE_UNKNOWN', 'UNFILLED', 'CLOSE_FAILED'/);
    expect(s).toMatch(/saptaOpen\.has\(String\(pairOfSignal\(s\)\)\.toUpperCase\(\)\)/);
  });
});

// ============================================================
// F. Deep-path UC gate parity + board widening + winProb recompute
// ============================================================
describe('v20.9.3 F — board/deep UC parity', () => {
  it('the deep path applies ultrafastGatePatch to the built signal (source-lock)', () => {
    const s = readFileSync(S_SIG, 'utf8');
    const i = s.indexOf('v20.9.3 FIX (H2): apply the SAME gate patch as the board');
    expect(i).toBeGreaterThan(0);
    expect(s.slice(i, i + 900)).toMatch(/ultrafastGatePatch\(uvD, built\)/);
    expect(s.slice(i, i + 900)).toMatch(/built\.ucRejected = true/);
  });
  it('board UC targets widened to 12 and stamped in parallel (source-lock)', () => {
    const s = readFileSync(S_SIG, 'utf8');
    expect(s).toMatch(/\.slice\(0, 12\)/);
    expect(s).toMatch(/Promise\.all\(ucTargets\.map\(async \(s\) =>/);
  });
  it('winProb is recomputed from the CAPPED score on REJECTED (source-lock)', () => {
    const s = readFileSync(S_SIG, 'utf8');
    expect(s).toMatch(/winProb was computed from the PRE-CAP[\s\S]{0,600}s\.superIntel\.winProb = computeWinProb\(\{/);
  });
});

// ============================================================
// G. exec-enter journal row + PM boot hydration (M)
// ============================================================
describe('v20.9.3 G — exec-enter positions survive restarts', () => {
  it('hydrateFromJournal seeds PM ladder state from execManaged rows (functional)', () => {
    const pm = new PositionManager({ port: new PaperPort() });
    expect(pm.hydrateFromJournal([
      { id: 'p-1', pair: 'B-BTC_USDT', symbol: 'BTC', side: 'LONG', status: 'OPEN', source: 'exec-enter', execManaged: true, entryPrice: 100, sl: 98, tp: 104, tp2: 108, qty: 0.5, leverage: 3, openedAt: Date.now() - 60_000 },
      { id: 'p-2', pair: 'B-ETH_USDT', symbol: 'ETH', side: 'SHORT', status: 'CLOSED', source: 'exec-enter', execManaged: true, entryPrice: 50, qty: 1 }, // closed — skipped
      { id: 'p-3', pair: 'B-SOL_USDT', symbol: 'SOL', side: 'LONG', status: 'OPEN', source: 'agent', entryPrice: 20, qty: 2 }, // not exec-enter — skipped
      { id: 'p-4', pair: 'B-XRP_USDT', symbol: 'XRP', side: 'LONG', status: 'OPEN', source: 'exec-enter', execManaged: true, entryPrice: 0, qty: 0 }, // unusable numbers — skipped
    ])).toBe(1);
    expect(pm._stateForTests().length).toBe(1);
    const st = pm._stateForTests()[0] as Record<string, unknown>;
    expect(st.pair).toBe('B-BTC_USDT');
    expect(st.origRisk).toBeCloseTo(2, 5);
    expect(st.tp1).toBe(104);
  });
  it('the route journals a real positions row (source-lock)', () => {
    const s = readFileSync(S_RT, 'utf8');
    expect(s).toMatch(/source: 'exec-enter', execManaged: true/);
  });
  it('boot hydrates from the shared journal + the futures watcher skips PM-owned rows (source-lock)', () => {
    expect(readFileSync(S_IDX, 'utf8')).toMatch(/hydrateFromJournal\?\.\(\(j\?\.positions\) \|\| \[\]\)/);
    expect(readFileSync(S_FUT, 'utf8')).toMatch(/!\(p\.execManaged && globalThis\.__positionManager\)/);
  });
});

// ============================================================
// H. Bot desk fixes
// ============================================================
describe('v20.9.3 H — bot desk', () => {
  it('botRisk fails CLOSED on an unusable peakEquity (mirrors the shared hardGate)', () => {
    const cfg = botRiskConfig({});
    const r = botRiskCheck({
      account: { startingEquity: 1000, equity: 900, peakEquity: NaN, tradesToday: 0 },
      openCounts: {}, cfg, bot: 'b1',
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('account_state_invalid(peak)');
  });
  it('a valid peak still measures drawdown from the PEAK (not start)', () => {
    const cfg = botRiskConfig({});
    const r = botRiskCheck({
      account: { startingEquity: 1000, equity: 1300, peakEquity: 1500, tradesToday: 0 }, // -13.3% from peak
      openCounts: {}, cfg, bot: 'b1',
    });
    expect(r.reasons.join(' ')).toMatch(/max_drawdown_kill\(13\.33% from peak\)/);
  });
  it('telegram order alerts are verdict-aware (source-lock)', () => {
    const s = readFileSync(S_RUN, 'utf8');
    expect(s).toMatch(/if \(opened\.ok\) \{\s*\r?\n\s*sendTelegramMessage\(`\[\$\{botId\}\] \$\{this\.cfg\.mode\}/);
    expect(s).toMatch(/OPEN FAILED —/);
  });
  it('the scan cap reads cfg.maxOpenPerBot instead of hardcoded 1 (source-lock)', () => {
    expect(readFileSync(S_RUN, 'utf8')).toMatch(/myOpen >= _maxOpen/);
  });
  it('shared-port settle resolves the owning strategy PER POSITION (source-lock)', () => {
    const s = readFileSync(S_RUN, 'utf8');
    expect(s).toMatch(/_owningStrategyOf = \(p\) =>/);
    expect(s).toMatch(/const strategy = _owningStrategyOf\(p\);/);
  });
});

// ============================================================
// I. Ops + scan wiring
// ============================================================
describe('v20.9.3 I — ops + scan wiring', () => {
  it('backup-state default dir points at the runtime bot-state dir (source-lock)', () => {
    const s = readFileSync(S_BKP, 'utf8');
    expect(s).toMatch(/join\(ROOT, 'data', 'bots'\)/);
    expect(s).not.toMatch(/join\(ROOT, 'server', 'data', 'bots'\)/);
  });
  it('BACKUP_STATE_ON_BOOT is actually wired in the supervisor (source-lock)', () => {
    const s = readFileSync(S_SUP, 'utf8');
    expect(s).toMatch(/BACKUP_STATE_ON_BOOT/);
    expect(s).toMatch(/backup-state\.mjs/);
  });
  it('expertPicks feeds the structure factor (source-lock)', () => {
    const s = readFileSync(S_EXP, 'utf8');
    expect(s).toMatch(/structurePro\(\{ candles, ind: ltfInd \}\)/);
    expect(s).toMatch(/structure: stv \}/);
  });
  it('the ML meta-ensemble frame sorts on the REAL date column (python source-lock)', () => {
    const py = readFileSync(join(ROOT, 'ml-service/models/train_signal.py'), 'utf8');
    expect(py).toMatch(/pd\.to_datetime\(r\.get\("date"\), errors="coerce"\)/);
    expect(py).not.toMatch(/pd\.Timestamp\(r\.name\)/);
  });
  it('recheck rows reset the UC verdict on a board side-flip (source-lock)', () => {
    const s = src('server/ai/signalRecheck.js');
    expect(s).toMatch(/sideFlipped \? \{ ultrafastVerdict: null, ultrafastAnswer: null \}/);
  });
  it('APP_PIN placeholders are refused at boot (source-lock)', () => {
    expect(readFileSync(S_IDX, 'utf8')).toMatch(/change_me_to_a_strong_pin/);
  });
});
