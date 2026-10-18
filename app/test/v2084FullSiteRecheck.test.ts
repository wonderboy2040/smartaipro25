// ============================================================
// test/v2084FullSiteRecheck.test.ts — FULL-SITE DEEP RECHECK ROUND 4
// ------------------------------------------------------------
// Behavioral + source-contract locks for the v20.8.4 fixes:
//   A. engine: mid-trade gap-through-stop fills at the OPEN (long &
//      short), target gap fills at the better open
//   B. settle: re-entrancy guard, close-verdict honored, slippage
//      charged, orphaned kill-switched positions still settle
//   C. botRiskPreCheck: pre-decider veto (no paid Jev call burned)
//      + total-daily-loss aggregate denominator
//   D. candleStore: delta semantics (append path, not full rewrite),
//      denomination poison reset, loadCandlesCached incremental tail
//   E. supervisor: single-instance lock, off-knob spellings, POSIX
//      npm tree-kill source contract
//   F. source contracts: Dockerfile COPY paths, .bat CRLF +
//      .gitattributes, manifest three-desk, bot.mjs XFF + rate-fix,
//      webhook inflight sync, PaperPort no-$100, index.js pre-auth
//      guard + Groq fallback + delta save
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../server/bots/core/engine.js';
import { saveCandles, loadCandles, loadCandlesCached } from '../server/bots/core/candleStore.js';
import { botRiskCheck, botRiskPreCheck, BOT_RISK_DEFAULTS } from '../server/bots/botRisk.js';
import { BotRunner, STRATEGIES } from '../server/bots/botRunner.js';
import { PaperPort } from '../server/exec/port.js';
import { createSupervisor } from '../server/supervisor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');

// deterministic detector: candidate on row i, take on decider approval
function gapStrategy({ iSignal = 1, side = 'LONG', stop, target } = {}) {
  let fired = false;
  return {
    id: 'gapfix', desk: 'crypto', instrumentType: 'crypto', lotSize: 1,
    sessionKey: null,
    prepare(bars) { return bars.map(b => ({ bar: b })); },
    detect(rows, i) {
      if (i === iSignal && !fired) {
        fired = true;
        return { symbol: 'TEST', side, entry: rows[i].bar.close, stop, target, features: {}, maxHoldBars: null };
      }
      return null;
    },
  };
}
const mkBars = (rows) => rows.map(([t, o, h, l, c]) => ({ time: t, open: o, high: h, low: l, close: c, volume: 100 }));
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const bars1 = mkBars([
  [T0, 101, 102, 100, 101],                 // signal bar (close 101)
  [T0 + 5 * 60000, 100.5, 101, 100, 100.8], // fill bar (engine fills at THIS open)
  [T0 + 10 * 60000, 100, 100.8, 99.5, 100], // normal hold bar
  [T0 + 15 * 60000, 80, 84, 79, 83],        // MID-TRADE GAP: opens at 80, far below stop 90
]);

describe('v20.8.4 A. engine mid-trade gap-through-stop', () => {
  const costFn = () => ({ total: 0 });
  it('LONG: bar opening beyond the stop fills at the OPEN (not the stop)', async () => {
    const r = await runBacktest({
      rows: gapStrategy({ stop: 90, target: 120 }).prepare(bars1),
      strategy: gapStrategy({ stop: 90, target: 120 }),
      decider: async () => ({ action: 'take' }), costFn, symbol: 'TEST',
      instrumentType: 'crypto', lotSize: 1,
      cfg: { slippageBpsCrypto: 0 },
    });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.exitWhy).toBe('stop');
    expect(t.exit).toBe(80); // the open, not the 90 stop
    expect(t.gapThroughStop).toBe(true);
    expect(t.netPnl).toBeLessThan(0);
  });
  it('SHORT mirror: bar opening ABOVE the stop fills at the open', async () => {
    const bars = mkBars([
      [T0, 100, 101, 99, 100],
      [T0 + 5 * 60000, 100.5, 101, 100, 100.8],
      [T0 + 10 * 60000, 100, 100.8, 99.5, 100],
      [T0 + 15 * 60000, 130, 134, 129, 133], // MID-TRADE gap up through short stop 110
    ]);
    const s = gapStrategy({ side: 'SHORT', stop: 110, target: 80 });
    const r = await runBacktest({
      rows: s.prepare(bars), strategy: s,
      decider: async () => ({ action: 'take' }), costFn, symbol: 'TEST',
      instrumentType: 'crypto', lotSize: 1, cfg: { slippageBpsCrypto: 0 },
    });
    const t = r.trades[0];
    expect(t.exit).toBe(130);
    expect(t.gapThroughStop).toBe(true);
    expect(t.netPnl).toBeLessThan(0);
  });
  it('target gap fills at the BETTER open (limit semantics)', async () => {
    const bars = mkBars([
      [T0, 100, 101, 99, 100],
      [T0 + 5 * 60000, 100.5, 101, 100, 100.8],
      [T0 + 10 * 60000, 125, 129, 124, 128], // opens beyond target 120
    ]);
    const s = gapStrategy({ stop: 90, target: 120 });
    const r = await runBacktest({
      rows: s.prepare(bars), strategy: s,
      decider: async () => ({ action: 'take' }), costFn, symbol: 'TEST',
      instrumentType: 'crypto', lotSize: 1, cfg: { slippageBpsCrypto: 0 },
    });
    const t = r.trades[0];
    expect(t.exitWhy).toBe('target');
    expect(t.exit).toBe(125); // the better open
  });
  it('no gap: stop fills at the stop as before (regression guard)', async () => {
    const bars = mkBars([
      [T0, 101, 102, 100, 101],
      [T0 + 5 * 60000, 100.5, 101, 100, 100.8],
      [T0 + 10 * 60000, 99, 100, 89.5, 91], // trades down through 90 intrabar
    ]);
    const s = gapStrategy({ stop: 90, target: 120 });
    const r = await runBacktest({
      rows: s.prepare(bars), strategy: s,
      decider: async () => ({ action: 'take' }), costFn, symbol: 'TEST',
      instrumentType: 'crypto', lotSize: 1, cfg: { slippageBpsCrypto: 0 },
    });
    const t = r.trades[0];
    expect(t.exit).toBe(90);
    expect(t.gapThroughStop).toBeFalsy();
  });
});

describe('v20.8.4 B. settle spine', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2084-settle-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const mkRunner = ({ markPriceProvider, execPort = null } = {}) => new BotRunner({
    stateDir: dir,
    env: { ...process.env, BOTS_ENABLED: 'orb_crypto_utc' },
    candleProvider: null,
    markPriceProvider: markPriceProvider || null,
    execPort,
  });

  it('re-entrancy guard: overlapping settleOpenTrades calls do not double-book', async () => {
    const runner = mkRunner({ markPriceProvider: async () => 50 });
    // build a port with one position via the runner's own plumbing
    const port = runner._ensurePaperPort('orb_crypto_utc');
    await port.open({ pair: 'BTC', side: 'LONG', qty: 1, type: 'market', price: 100, sl: 90, tp: 200, clientId: 'orb_crypto_utc-BTC-LONG-1' });
    // mark collapses far below the stop
    const settleAll = () => runner.settleOpenTrades();
    const [a, b] = await Promise.all([settleAll(), settleAll()]);
    const results = [...a, ...b];
    expect(results).toHaveLength(1); // exactly ONE settle booked
    const { loadAccount } = await import('../server/bots/accounts.js');
    const acc = loadAccount(dir, 'orb_crypto_utc');
    expect(acc.tradesToday).toBe(1);
  });

  it('close-verdict honored: a REJECTED close books nothing + settle_close_failed event', async () => {
    const runner = mkRunner({ markPriceProvider: async () => 50 });
    const badPort = {
      mode: 'paper',
      getPositions: async () => [{ id: 'p1', pair: 'BTC', side: 'LONG', qty: 1, avgPrice: 100, sl: 90, tp: null, markPrice: null, clientId: 'orb_crypto_utc-BTC-LONG-2', openedAt: Date.now() - 3600_000, meta: null }],
      close: async () => ({ ok: false, error: 'position not found' }),
      setMarkPrice: () => {},
    };
    // inject directly
    (runner as any)._paperPorts = { orb_crypto_utc: badPort };
    const settled = await runner.settleOpenTrades();
    expect(settled).toHaveLength(0);
    const { loadAccount } = await import('../server/bots/accounts.js');
    const acc = loadAccount(dir, 'orb_crypto_utc');
    expect(acc.tradesToday).toBe(0);
    const { readEvents } = await import('../server/bots/botState.js');
    const evs = readEvents(dir, 'orb_crypto_utc', 50);
    expect(evs.some((e) => e.kind === 'settle_close_failed')).toBe(true);
  });

  it('slippage charged: netPnl = gross - fees - slip (engine parity)', async () => {
    const runner = mkRunner({ markPriceProvider: async () => 50 });
    const port = runner._ensurePaperPort('orb_crypto_utc');
    await port.open({ pair: 'BTC', side: 'LONG', qty: 1, type: 'market', price: 100, sl: 90, tp: 200, clientId: 'orb_crypto_utc-BTC-LONG-3' });
    port.setMarkPrice('BTC', 50); // stop hit at mark 50
    const settled = await runner.settleOpenTrades();
    expect(settled).toHaveLength(1);
    const t = settled[0];
    expect(t.grossPnl).toBe(-50);
    expect(t.slippage).toBeGreaterThan(0);
    expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees - t.slippage, 6);
  });

  it('orphaned positions of a KILL-SWITCHED bot still settle (kill stops entries, never exits)', async () => {
    const { setKillSwitch } = await import('../server/bots/botState.js');
    // 1. bot trades normally, leaves an open position, state persisted
    const runner = mkRunner({ markPriceProvider: async () => 50 });
    const port = runner._ensurePaperPort('orb_crypto_utc');
    await port.open({ pair: 'BTC', side: 'LONG', qty: 1, type: 'market', price: 100, sl: 90, tp: 200, clientId: 'orb_crypto_utc-BTC-LONG-4' });
    await runner._persistPaperPositions('orb_crypto_utc', port);
    // 2. kill switch ON + fresh runner (restart): tick skips at the gate,
    //    settle must STILL reach the persisted position
    setKillSwitch(dir, 'orb_crypto_utc', true);
    const runner2 = mkRunner({ markPriceProvider: async () => 50 });
    const tickR = await runner2.tick('orb_crypto_utc');
    expect(tickR.skipped).toBe('kill_switch');
    const settled = await runner2.settleOpenTrades();
    expect(settled).toHaveLength(1);
    expect(settled[0].symbol).toBe('BTC');
  });
});

describe('v20.8.4 C. botRiskPreCheck', () => {
  it('vetoes max_trades_per_day BEFORE any decider (no paid Jev call)', () => {
    const r = botRiskPreCheck({
      cfg: BOT_RISK_DEFAULTS, bot: 'orb_crypto_utc',
      account: { startingEquity: 10000, equity: 10000, tradesToday: 4, lastTradeTs: null },
      openCounts: { perBot: {}, total: 0 },
      now: Date.now(),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('max_trades_per_day'))).toBe(true);
  });
  it('passes a clean account (same reasons as full check, minus feed/fee)', () => {
    const r = botRiskPreCheck({
      cfg: BOT_RISK_DEFAULTS, bot: 'b',
      // v20.9.3: peakEquity added — the drawdown rule is FAIL-CLOSED on an
      // unusable peak now (mirrors the shared hardGate); real accounts
      // always carry peakEquity (accounts.js seeds it at creation).
      account: { startingEquity: 10000, equity: 10000, peakEquity: 10000, tradesToday: 0, lastTradeTs: null },
      openCounts: { perBot: {}, total: 0 },
      now: Date.now(),
    });
    expect(r.ok).toBe(true);
  });
  it('total_daily_loss uses the AGGREGATE starting equity denominator', () => {
    // -400 on a 100k aggregate = -0.4% (under the 4% kill) — the old code
    // divided by THIS bot's 10k startEq = -4% and killed it
    const acc = { startingEquity: 10000, equity: 9600, tradesToday: 0, lastTradeTs: null };
    const oc = { perBot: {}, total: 0, totalTodayPnl: -400, totalTodayStartEq: 100000 };
    const pre = botRiskPreCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'b', account: acc, openCounts: oc, now: Date.now() });
    expect(pre.reasons.some((x) => x.startsWith('total_daily_loss'))).toBe(false);
    // and the FULL check agrees (shared helper)
    const full = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'b', account: acc, openCounts: oc, feedAgeSec: null, now: Date.now(), killSwitches: {}, feeGate: null });
    expect(full.reasons).toEqual(pre.reasons);
  });
});

describe('v20.8.4 D. candleStore delta + cache', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2084-store-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('re-saving the SAME window is a no-op append path (no full rewrite, no dup lines)', () => {
    const bars = [];
    for (let i = 0; i < 100; i++) bars.push({ t: T0 + i * 300000, o: 100, h: 101, l: 99, c: 100.5, v: 10 });
    const r1 = saveCandles(dir, 'crypto', 'BTC', '5m', bars, { source: 'test' });
    expect(r1.added).toBe(100);
    const before = fs.readFileSync(path.join(dir, 'candles', 'crypto', 'BTC', '5m.jsonl'), 'utf8');
    // the OLD caller behavior: pass the whole window again
    const r2 = saveCandles(dir, 'crypto', 'BTC', '5m', bars, { source: 'test' });
    const after = fs.readFileSync(path.join(dir, 'candles', 'crypto', 'BTC', '5m.jsonl'), 'utf8');
    expect(r2.added).toBe(0);
    expect(after).toBe(before); // byte-identical: no rewrite, no dupes
    expect(loadCandles(dir, 'crypto', 'BTC', '5m').bars).toHaveLength(100);
  });
  it('denomination switch performs a CLEAN RESET (no mixed-currency merge)', () => {
    const usdt = [];
    for (let i = 0; i < 50; i++) usdt.push({ t: T0 + i * 300000, o: 100, h: 101, l: 99, c: 100.5, v: 10 });
    saveCandles(dir, 'crypto', 'BTC', '5m', usdt, { source: 'binance' });
    // INR-scale batch (~85x) for the SAME symbol
    const inr = usdt.map((b) => ({ ...b, o: b.o * 85, h: b.h * 85, l: b.l * 85, c: b.c * 85 }));
    const r = saveCandles(dir, 'crypto', 'BTC', '5m', inr, { source: 'coindcx-inr' });
    expect(r.denominationReset).toBe(true);
    const { bars, meta } = loadCandles(dir, 'crypto', 'BTC', '5m');
    expect(bars).toHaveLength(50);
    expect(bars[0].c).toBeGreaterThan(8000); // INR-scale only
    expect(meta.denominationReset).toBe(true);
  });
  it('loadCandlesCached: append-only growth parses ONLY the new tail', () => {
    const bars = [];
    for (let i = 0; i < 200; i++) bars.push({ t: T0 + i * 300000, o: 100, h: 101, l: 99, c: 100.5, v: 10 });
    saveCandles(dir, 'crypto', 'ETH', '5m', bars, { source: 'test' });
    const c1 = loadCandlesCached(dir, 'crypto', 'ETH', '5m');
    expect(c1.bars).toHaveLength(200);
    // append 2 new bars (simulating the next tick's delta)
    const next = [
      { t: T0 + 200 * 300000, o: 100, h: 101, l: 99, c: 100.5, v: 10 },
      { t: T0 + 201 * 300000, o: 100, h: 101, l: 99, c: 100.5, v: 10 },
    ];
    saveCandles(dir, 'crypto', 'ETH', '5m', next, { source: 'test' });
    const c2 = loadCandlesCached(dir, 'crypto', 'ETH', '5m');
    expect(c2.bars).toHaveLength(202);
    expect(c2.bars[201].t).toBe(T0 + 201 * 300000);
    // corrupt-cache self-heal: external shrink triggers a full reload
    fs.rmSync(path.join(dir, 'candles', 'crypto', 'ETH', '5m.jsonl'));
    const c3 = loadCandlesCached(dir, 'crypto', 'ETH', '5m');
    expect(c3.bars).toHaveLength(0);
  });
});

describe('v20.8.4 E. supervisor single-instance + knobs', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2084-sup-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const mk = (env = {}) => createSupervisor({
    env: { WATCHDOG_LOG_FILE: 'off', WATCHDOG_JOURNAL: path.join(dir, 'j.log'), ...env },
  });

  it('acquireLock → second supervisor with a LIVE pid is refused', () => {
    const s1 = mk({ WATCHDOG_LOCK_FILE: path.join(dir, 'watchdog.lock') });
    const a1 = s1._i.acquireLock();
    expect(a1.ok).toBe(true);
    const s2 = mk({ WATCHDOG_LOCK_FILE: path.join(dir, 'watchdog.lock') });
    const a2 = s2._i.acquireLock();
    expect(a2.ok).toBe(false);
    expect(a2.pid).toBe(process.pid); // our own pid is definitely alive
    s1._i.releaseLock();
    const s3 = mk({ WATCHDOG_LOCK_FILE: path.join(dir, 'watchdog.lock') });
    expect(s3._i.acquireLock().ok).toBe(true); // released = re-acquirable
  });
  it('stale lock (dead pid) is take-over-able', () => {
    fs.mkdirSync(path.join(dir, 'candles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'watchdog.lock'), JSON.stringify({ pid: 999999999, at: Date.now() }));
    const s = mk({ WATCHDOG_LOCK_FILE: path.join(dir, 'watchdog.lock') });
    expect(s._i.acquireLock().ok).toBe(true);
  });
  it('WATCHDOG_AUTO_BUILD accepts off/false/no spellings (only exact 0 used to disable)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      const s = mk({ WATCHDOG_AUTO_BUILD: v });
      expect(s._i.knobs.autoBuild, `spell '${v}' should disable`).toBe(false);
    }
    expect(mk({ WATCHDOG_AUTO_BUILD: '1' })._i.knobs.autoBuild).toBe(true);
    expect(mk({})._i.knobs.autoBuild).toBe(true);
    expect(mk({ WATCHDOG_AUTO_INSTALL: 'off' })._i.knobs.autoInstall).toBe(false);
  });
});

describe('v20.8.4 F. source contracts (deploy/bat/frontend/bot.mjs)', () => {
  const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

  it('Dockerfile COPYs app/telegram-bot (context-root fix) and runs as non-root', () => {
    const d = read('deploy/Dockerfile');
    expect(d).toContain('COPY app/telegram-bot/package*.json ./telegram-bot/');
    expect(d).toContain('COPY app/telegram-bot/ ./telegram-bot/');
    expect(d).not.toMatch(/^COPY telegram-bot\//m);
    expect(d).toContain('USER node');
  });
  it('.dockerignore covers telegram-bot node_modules + ml-service store', () => {
    const d = read('.dockerignore');
    expect(d).toContain('app/telegram-bot/node_modules');
    expect(d).toContain('app/ml-service/store');
  });
  it('all three .bat files are CRLF (cmd label-scanner hazard)', () => {
    for (const f of ['app/Start-SmartAI-Watchdog.bat', 'app/SETUP-v20.bat', 'app/Start-AutoBrowser.bat']) {
      const s = read(f);
      expect(s).toMatch(/\r\n/);
      expect(s).not.toMatch(/[^\r]\n/); // no bare LF anywhere
    }
  });
  it('.gitattributes pins *.bat to CRLF', () => {
    expect(read('.gitattributes')).toMatch(/^\*\.bat text eol=crlf$/m);
  });
  it('manifest.json is three-desk with a bots shortcut', () => {
    const m = read('app/public/manifest.json');
    expect(m).toContain('three-desk');
    expect(m).not.toContain('two-desk');
    expect(m).toContain('?tab=bots');
  });
  it('index.html og/twitter descriptions are three-desk', () => {
    const h = read('app/index.html');
    expect(h).not.toContain('two-desk');
    expect(h).toContain('JEV Bot Lab');
  });
  it('bot.mjs: XFF only trusted behind TRUST_PROXY=1 + rate cleanup fixed', () => {
    const b = read('app/telegram-bot/bot.mjs');
    expect(b).toContain("TRUST_PROXY === '1'");
    expect(b).toContain('now - v[v.length - 1] > 60_000'); // the FIXED cleanup condition
  });
  it('webhook.js: _inflight.add is synchronous and ADJACENT to setImmediate (TOCTOU fix)', () => {
    const w = read('app/server/telegram/webhook.js');
    expect(w).toMatch(/_inflight\.add\(chatKey\);\s*\n\s*setImmediate/);
  });
  it('PaperPort never fabricates a $100 fill', () => {
    const p = read('app/server/exec/port.js');
    expect(p).not.toContain('|| 100)');
  });
  it('index.js: pre-auth guard before express.json + Groq fallback current + delta save', async () => {
    const idx = read('app/server/index.js');
    const guardPos = idx.indexOf('v20.8.4 FIX (M — pre-auth body-parse CPU surface)');
    const jsonPos = idx.indexOf("app.use(express.json({ limit: '4mb' }))");
    expect(guardPos).toBeGreaterThan(-1);
    expect(jsonPos).toBeGreaterThan(guardPos);
    expect(idx).not.toContain("'llama-3.3-70b-versatile'");
    expect(idx).toContain('saveDelta'); // delta persistence contract
  });
  it('useBots: token-expiry probe + reconnect backfill present', () => {
    const u = read('app/src/components/bots/useBots.ts');
    expect(u).toContain("apiFetch('/api/bots/status')");
    expect(u).toContain("apiFetch('/api/bots/events?limit=500')");
    expect(u).toContain('coerceStatus');
  });
  it('supervisor: POSIX npm tree-kill + node gate present', () => {
    const s = read('app/server/supervisor.js');
    expect(s).toContain("process.kill(-child.pid, 'SIGKILL')");
    expect(s).toContain('_nodeMajor');
    expect(s).toContain('acquireLock');
  });
  it('runThreeArmBacktest accepts instrumentType override', async () => {
    const { runThreeArmBacktest } = await import('../server/bots/botRunner.js');
    const src = read('app/server/bots/botRunner.js');
    expect(src).toContain('instrumentType = null, lotSize = null');
    expect(typeof runThreeArmBacktest).toBe('function');
  });
  it('ml-service /train runs off the event loop + fail-closed non-local', () => {
    const py = read('app/ml-service/app/main.py');
    expect(py).toContain('run_in_threadpool(_train_models_sync, req)');
    expect(py).toContain('refuses unauthenticated non-local traffic');
  });
});
