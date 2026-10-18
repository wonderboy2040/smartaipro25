// ============================================================
// test/v2082BotlabHardening.test.ts — Jev Bot Lab v20.8.2
// ------------------------------------------------------------
// Behavioral locks for the v20.8.2 deep-recheck fixes:
//   A. orbIn strategy.sessionKey present (attempt persistence spine)
//   B. botRiskCheck feedMaxAgeSec window alignment
//   C. PaperPort: duplicate clientId returns the EXISTING position;
//      openedAt/meta stamping; hydrateOpenPositions round-trip
//   D. candleStore: append-only save (no dup lines, forming-bar tail
//      fix-up, out-of-order full-merge), mergeBarSeries keep-newest,
//      sameDenomination guard
//   E. botState.readEvents: mtime cache never serves stale data
//      (external writes must be picked up)
//   F. BotRunner settle: maxHoldBars time-stop + IST square-off fire
//      with exitWhy labels; open-count refresh within one tick
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import orbIn from '../server/bots/strategies/orbIn.js';
import { makeOrbCrypto } from '../server/bots/strategies/orbCrypto.js';
import { botRiskCheck, BOT_RISK_DEFAULTS } from '../server/bots/botRisk.js';
import { PaperPort } from '../server/exec/port.js';
import { saveCandles, loadCandles, mergeBarSeries, sameDenomination } from '../server/bots/core/candleStore.js';
import { appendEvent, readEvents } from '../server/bots/botState.js';
import { BotRunner } from '../server/bots/botRunner.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2082botlab-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------- A. orbIn sessionKey ----------------
describe('A. orbIn attempt-persistence spine (sessionKey)', () => {
  it('exposes sessionKey on the strategy object (runner gates on it)', () => {
    expect(typeof orbIn.sessionKey).toBe('function');
    const bar = { time: Date.UTC(2026, 9, 5, 4, 0) }; // 09:30 IST
    expect(orbIn.sessionKey(bar)).toBe(orbIn.sessionKey({ time: bar.time + 3600000 }));
    expect(orbIn.sessionKey(bar)).not.toBe(orbIn.sessionKey({ time: bar.time + 86400000 }));
  });
  it('orbCrypto also keys sessions (regression)', () => {
    const s = makeOrbCrypto({ session: 'utc' });
    expect(typeof s.sessionKey).toBe('function');
  });
});

// ---------------- B. staleness window alignment ----------------
describe('B. botRiskCheck staleness window', () => {
  const base = {
    cfg: { ...BOT_RISK_DEFAULTS, staleFeedSeconds: 90 },
    bot: 'orb_crypto_utc',
    account: { equity: 10000, startingEquity: 10000, todayPnl: { gross: 0, net: 0 }, tradesToday: 0 },
    openCounts: { perBot: {}, total: 0 },
    killSwitches: {},
    feeGate: null,
  };
  it('vetoes raw feedAge beyond the legacy 90s window when no override is passed', () => {
    const r = botRiskCheck({ ...base, feedAgeSec: 200 });
    expect(r.ok).toBe(false);
    expect(r.reasons.some(x => x.startsWith('stale_feed'))).toBe(true);
  });
  it('honors the runner-aligned window (staleFeedSeconds + one 5m interval)', () => {
    const r = botRiskCheck({ ...base, feedAgeSec: 200, feedMaxAgeSec: 90 + 300 });
    expect(r.reasons.some(x => x.startsWith('stale_feed'))).toBe(false);
  });
  it('still vetoes beyond the aligned window', () => {
    const r = botRiskCheck({ ...base, feedAgeSec: 391, feedMaxAgeSec: 90 + 300 });
    expect(r.reasons.some(x => x.startsWith('stale_feed'))).toBe(true);
  });
});

// ---------------- C. PaperPort ----------------
describe('C. PaperPort idempotency + rehydration', () => {
  it('duplicate clientId returns the EXISTING position (not a positionless ok)', async () => {
    const p = new PaperPort({ startingEquityUSDT: 10000 });
    const a = await p.open({ pair: 'BTC', side: 'LONG', qty: 0.1, leverage: 2, type: 'market', price: 50000, clientId: 'orb_crypto_utc-BTC-LONG-1' });
    expect(a.ok).toBe(true);
    const b = await p.open({ pair: 'BTC', side: 'LONG', qty: 0.1, leverage: 2, type: 'market', price: 51000, clientId: 'orb_crypto_utc-BTC-LONG-1' });
    expect(b.ok).toBe(true);
    expect(b.dup).toBe(true);
    expect(b.orderId).toBe(a.orderId);
    const ps = await p.getPositions();
    expect(ps).toHaveLength(1); // no phantom second position
    expect(ps[0].avgPrice).toBeCloseTo(50000, 2); // original fill preserved
  });
  it('stamps openedAt + meta on positions', async () => {
    const p = new PaperPort({ startingEquityUSDT: 10000 });
    const t0 = Date.now();
    const a = await p.open({
      pair: 'BTC', side: 'LONG', qty: 0.1, leverage: 2, type: 'market', price: 50000,
      clientId: 'c1', meta: { maxHoldBars: 288, squareOffIST: null, desk: 'crypto' },
    });
    expect(a.ok).toBe(true);
    const ps = await p.getPositions();
    expect(ps[0].openedAt).toBeGreaterThanOrEqual(t0);
    expect(ps[0].meta?.maxHoldBars).toBe(288);
  });
  it('hydrateOpenPositions round-trips a snapshot into a fresh port', async () => {
    const p1 = new PaperPort({ startingEquityUSDT: 10000 });
    await p1.open({
      pair: 'ETH', side: 'SHORT', qty: 0.5, leverage: 3, type: 'market', price: 3000,
      sl: 3100, tp: 2800, clientId: 'orb_crypto_utc-ETH-SHORT-9',
      meta: { maxHoldBars: 288, squareOffIST: null, desk: 'crypto' },
    });
    const snap = await p1.getPositions();
    const p2 = new PaperPort({ startingEquityUSDT: 10000 });
    p2.hydrateOpenPositions(snap);
    const ps = await p2.getPositions();
    expect(ps).toHaveLength(1);
    expect(ps[0].pair).toBe('ETH');
    expect(ps[0].side).toBe('SHORT');
    expect(ps[0].clientId).toBe('orb_crypto_utc-ETH-SHORT-9');
    expect(ps[0].sl).toBe(3100);
    expect(ps[0].meta?.maxHoldBars).toBe(288);
    // duplicate-clientId guard stays armed after rehydration
    const dup = await p2.open({ pair: 'ETH', side: 'SHORT', qty: 0.5, leverage: 3, type: 'market', price: 3000, clientId: 'orb_crypto_utc-ETH-SHORT-9' });
    expect(dup.dup).toBe(true);
    expect(await p2.getPositions()).toHaveLength(1);
    // margin reserved (free reduced), never negative
    const eq = await p2.getEquity();
    expect(eq.freeUSDT).toBeLessThan(10000);
    expect(eq.freeUSDT).toBeGreaterThanOrEqual(0);
  });
});

// ---------------- D. candleStore ----------------
describe('D. candleStore append-only + merge helpers', () => {
  // normBar floors t to second precision — use real epoch-ms values
  const T0 = 1_750_000_000_000;
  const bar = (i, c) => ({ t: T0 + i * 300_000, o: c, h: c + 1, l: c - 1, c, v: 10 });
  const feedBar = (i, c) => ({ time: T0 + i * 300_000, open: c, high: c + 1, low: c - 1, close: c, volume: 10 });
  const tOf = (i) => T0 + i * 300_000;

  it('append path: no duplicate timestamps, no full rewrite needed', () => {
    saveCandles(dir, 'crypto', 'BTC', '5m', [bar(1, 100), bar(2, 101), bar(3, 102)], { source: 'binance-usdt' });
    const r = saveCandles(dir, 'crypto', 'BTC', '5m', [bar(4, 103), bar(5, 104)], { source: 'binance-usdt' });
    expect(r.added).toBe(2);
    const { bars } = loadCandles(dir, 'crypto', 'BTC', '5m');
    expect(bars.map(b => b.t)).toEqual([tOf(1), tOf(2), tOf(3), tOf(4), tOf(5)]);
  });
  it('forming-bar tail fix-up: same-t bar is UPDATED in place, not duplicated', () => {
    saveCandles(dir, 'crypto', 'BTC', '5m', [bar(1, 100), bar(2, 101), bar(3, 102)], {});
    const r = saveCandles(dir, 'crypto', 'BTC', '5m', [bar(3, 999), bar(4, 104)], {});
    expect(r.added).toBe(1); // t=4 only; t=3 replaced
    const { bars } = loadCandles(dir, 'crypto', 'BTC', '5m');
    expect(bars).toHaveLength(4);
    expect(bars.find(b => b.t === tOf(3))?.c).toBe(999);
  });
  it('out-of-order batch (backfill) takes the full-merge path, keep-newest', () => {
    saveCandles(dir, 'crypto', 'BTC', '5m', [bar(10, 100), bar(11, 101)], {});
    saveCandles(dir, 'crypto', 'BTC', '5m', [bar(9, 90), bar(10, 105)], {});
    const { bars } = loadCandles(dir, 'crypto', 'BTC', '5m');
    expect(bars.map(b => b.t)).toEqual([tOf(9), tOf(10), tOf(11)]);
    expect(bars.find(b => b.t === tOf(10))?.c).toBe(105); // newest write wins
  });
  it('mergeBarSeries dedupes keep-newest across shapes and caps', () => {
    const hist = [bar(1, 100), bar(2, 101)];
    const fresh = [feedBar(2, 202), feedBar(3, 303)];
    const m = mergeBarSeries(hist, fresh, { maxBars: 10 });
    expect(m.map(b => b.t)).toEqual([tOf(1), tOf(2), tOf(3)]);
    expect(m.find(b => b.t === tOf(2)).c).toBe(202);
    const capped = mergeBarSeries(hist, fresh, { maxBars: 2 });
    expect(capped.map(b => b.t)).toEqual([tOf(2), tOf(3)]); // newest tail kept
  });
  it('sameDenomination flags an INR-scale store against USDT-scale fresh', () => {
    expect(sameDenomination(9500000, 110000)).toBe(false); // ~86x apart
    expect(sameDenomination(109500, 110000)).toBe(true);   // same scale
    expect(sameDenomination(null, 110000)).toBe(true);      // unknown -> keep history
  });
});

// ---------------- E. readEvents cache ----------------
describe('E. readEvents mtime cache', () => {
  it('picks up EXTERNAL writes (stat mismatch re-reads)', () => {
    appendEvent(dir, 'orb_in', { kind: 'decision', action: 'wait' });
    const first = readEvents(dir, 'orb_in', 50);
    expect(first).toHaveLength(1);
    // external writer (CLI / another process) appends directly
    const p = path.join(dir, 'orb_in.events.jsonl');
    fs.appendFileSync(p, JSON.stringify({ kind: 'order', bot: 'orb_in', at: new Date().toISOString(), symbol: 'NIFTY', ok: true }) + '\n');
    const second = readEvents(dir, 'orb_in', 50);
    expect(second).toHaveLength(2);
    expect(second[1].kind).toBe('order');
  });
  it('same-process appendEvent is immediately visible', () => {
    appendEvent(dir, 'lvl', { kind: 'skip', reason: 'stale_feed(1s)' });
    appendEvent(dir, 'lvl', { kind: 'risk_block', reasons: ['kill_switch'] });
    const evs = readEvents(dir, 'lvl', 50);
    expect(evs).toHaveLength(2);
    expect(evs[1].reasons[0]).toBe('kill_switch');
  });
  it('returns cloned objects (caller mutation cannot poison the cache)', () => {
    appendEvent(dir, 'orb_in', { kind: 'decision', action: 'take' });
    const a = readEvents(dir, 'orb_in', 50);
    a[0].kind = 'MUTATED';
    const b = readEvents(dir, 'orb_in', 50);
    expect(b[0].kind).toBe('decision');
  });
});

// ---------------- F. settle time-exits + tick cap refresh ----------------
describe('F. BotRunner settle time-exits', () => {
  function runnerWithPort(port: PaperPort, markPrice: number | null) {
    const r = new BotRunner({
      stateDir: dir,
      env: { ...process.env, BOTS_ENABLED: 'orb_crypto_utc' },
      candleProvider: null,
      markPriceProvider: async () => markPrice,
    });
    // @ts-expect-error test injection of a pre-loaded paper port
    r._paperPorts = { orb_crypto_utc: port };
    return r;
  }

  it('closes a position past maxHoldBars (exitWhy time_stop) even when SL/TP not hit', async () => {
    const port = new PaperPort({ startingEquityUSDT: 10000 });
    const opened = await port.open({
      pair: 'BTC', side: 'LONG', qty: 0.1, leverage: 2, type: 'market', price: 50000,
      sl: 40000, tp: 60000, clientId: 'orb_crypto_utc-BTC-LONG-1', // far from mark
      meta: { maxHoldBars: 288, squareOffIST: null, desk: 'crypto' },
    });
    expect(opened.ok).toBe(true);
    // age the position beyond 288 x 5m
    // @ts-expect-error test hook
    for (const [, p] of port._positions) p.openedAt = Date.now() - (289 * 5 * 60000);
    const r = runnerWithPort(port, 50500);
    const settled = await r.settleOpenTrades({ now: Date.now() });
    expect(settled).toHaveLength(1);
    expect(settled[0].botId).toBe('orb_crypto_utc');
    const evs = readEvents(dir, 'orb_crypto_utc', 20);
    const settleEv = evs.find(e => e.kind === 'settle');
    expect(settleEv?.exitWhy).toBe('time_stop');
    expect((await port.getPositions())).toHaveLength(0);
  });

  it('square-off fires for an India position after 15:10 IST (or overnight)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 500000 });
    const opened = await port.open({
      pair: 'NIFTY', side: 'LONG', qty: 2, leverage: 1, type: 'market', price: 25000,
      sl: 24000, tp: 27000, clientId: 'orb_in-NIFTY-LONG-1',
      meta: { maxHoldBars: null, squareOffIST: '15:10', desk: 'india' },
    });
    expect(opened.ok).toBe(true);
    // put `now` at 15:25 IST on the same IST day as the open
    const nowIst1535 = Date.UTC(2026, 9, 5, 9, 55); // 15:25 IST
    // @ts-expect-error test hook
    for (const [, p] of port._positions) p.openedAt = Date.UTC(2026, 9, 5, 4, 0); // 09:30 IST same day
    const r = runnerWithPort(port, 25100);
    const settled = await r.settleOpenTrades({ now: nowIst1535 });
    expect(settled).toHaveLength(1);
    expect(settled[0].botId).toBe('orb_in'); // owner attributed via clientId prefix
    const evs = readEvents(dir, 'orb_in', 20);
    const settleEv = evs.find(e => e.kind === 'settle');
    expect(settleEv?.exitWhy).toBe('square_off');
  });

  it('time-stop does NOT fire within the hold window', async () => {
    const port = new PaperPort({ startingEquityUSDT: 10000 });
    await port.open({
      pair: 'BTC', side: 'LONG', qty: 0.1, leverage: 2, type: 'market', price: 50000,
      sl: 40000, tp: 60000, clientId: 'orb_crypto_utc-BTC-LONG-2',
      meta: { maxHoldBars: 288, squareOffIST: null, desk: 'crypto' },
    });
    const r = runnerWithPort(port, 50500);
    const settled = await r.settleOpenTrades({ now: Date.now() });
    expect(settled).toHaveLength(0);
    expect((await port.getPositions())).toHaveLength(1);
  });
});
