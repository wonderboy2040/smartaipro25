// ============================================================
// test/wrongSignalRemoval2124.test.ts — v21.23.4 REGRESSION LOCKS
// ------------------------------------------------------------
// USER COMPLAINT (3rd round): "site me jo bhi trade signals de rahe
// hai sab ke sab wrong direction me hai — sab opposite jaa rahe hai.
// Jo bhi wrong signals de rahe hai unko remove karo, concrete level."
//
// Deep-pro fresh-eyes audit (3 parallel agents) ne root cause pakda:
// order layer + data layer + sign conventions + UI sab VERIFIED SAHI —
// asli "wrong signal" sources DO documented degenerate modes the:
//   D1. India daily-fallback: 15m/1h series missing → committee SILENTLY
//       YESTERDAY's daily trend pe vote karti thi — in-repo documented
//       live-proven "90% opposite" disease (RELIANCE daily RSI 41.8/SHORT
//       jabki 15m RSI 83/rally).
//   D2. Crypto fresh-tape-absent: 15m tape missing → 4 lagging 1h trend
//       seats AFTER-the-move vote — replay-measured 29% WR / avgR −0.35.
//
// Ye file in dono wrong-signal SOURCES ke REMOVAL ko lock karti hai +
// runtime direction certificate + side-alias safety + store invariants.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { aggregateVotes, buildSignal } from '../server/ai/ensemble.js';
import { sideSignOf, buildSuperBlueprint } from '../server/ai/superIntel.js';
import { runDirectionSelfTest } from '../server/ai/directionSelfTest.js';
import { saveCandles, loadCandles } from '../server/bots/core/candleStore.js';

const readSrc = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');

// A synthetic STRONG-grade vote pack: 4 lagging 1h trend seats voting LONG.
function laggingTrendVotes({ tapeAbsent } = { tapeAbsent: true }) {
  const mk = (id: string, dir: number, conf = 72) => ({
    id, name: id, role: 'x', weight: 1.3, dir, conf, reasons: ['ok'],
  });
  const votes: Array<Record<string, unknown>> = [
    mk('trend', 1, 76), mk('macross', 1, 70), mk('momentum', 1, 68), mk('sr', 1, 66),
    { ...mk('tape', 0, 0), reasons: ['15m tape unavailable — model abstains (honest degrade)'], ...(tapeAbsent ? { tapeDataAbsent: true } : {}) },
  ];
  return votes;
}

describe('v21.23.4 — D2: FRESH-TAPE-ABSENT degenerate mode detected + removed', () => {
  it('tape data ABSENT → consensus carries freshTapeAbsent + summary says the 29% WR mode', () => {
    const c = aggregateVotes(laggingTrendVotes({ tapeAbsent: true }));
    expect(c.freshTapeAbsent).toBe(true);
    expect(String(c.summary)).toContain('FRESH-TAPE-ABSENT');
    expect(String(c.summary)).toContain('29%');
    expect(c.side).toBe('LONG'); // side abhi bhi dikhta hai (reference) — par flag ke saath
  });

  it('tape PRESENT but genuinely neutral → NO freshTapeAbsent flag (data-missing ≠ market-neutral)', () => {
    const c = aggregateVotes(laggingTrendVotes({ tapeAbsent: false }));
    expect(c.freshTapeAbsent).toBeUndefined();
  });

  it('buildSignal: freshTapeAbsent → dataDegraded stamped + executable NEVER true', () => {
    const consensus = aggregateVotes(laggingTrendVotes({ tapeAbsent: true }));
    const sig = buildSignal({
      symbol: 'BTC', market: 'CRYPTO', ctx: { ltp: 100, changePct: 1 },
      votes: laggingTrendVotes({ tapeAbsent: true }), consensus,
      plan: { entry: 100, stopLoss: 96, t1: 108, t2: 116, riskPct: 4 },
    });
    expect(sig.dataDegraded).toBe('FRESH-TAPE-ABSENT');
    expect(String(sig.degradedReason)).toContain('lagging 1h');
    expect(sig.executable).toBe(false);
  });

  it('buildSignal: fresh tape present → NO dataDegraded stamp (flag reserved for data-absent only)', () => {
    const consensus = aggregateVotes(laggingTrendVotes({ tapeAbsent: false }));
    const sig = buildSignal({
      symbol: 'BTC', market: 'CRYPTO', ctx: { ltp: 100, changePct: 1 },
      votes: laggingTrendVotes({ tapeAbsent: false }), consensus,
      plan: { entry: 100, stopLoss: 96, t1: 108, t2: 116, riskPct: 4 },
    });
    expect(sig.dataDegraded).toBeUndefined();
    expect(consensus.freshTapeAbsent).toBeUndefined();
  });
});

describe('v21.23.4 — D1: India daily-fallback suppression source pins', () => {
  it('signals.js: both ctx builders stamp __tfDegraded (stock + index)', () => {
    const src = readSrc('server/ai/signals.js');
    // stock builder + index builder — dono me flag
    const hits = (src.match(/__tfDegraded = 'INTRADAY-TF-UNAVAILABLE/g) || []).length;
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(src).toContain('90% opposite');
  });

  it('signals.js: board path SUPPRESSES degraded symbols + emits honest degraded ledger', () => {
    const src = readSrc('server/ai/signals.js');
    expect(src).toContain('if (ctx.__tfDegraded) {');
    expect(src).toContain('degradedSymbols.push({ symbol: ctx.symbol, reason: ctx.__tfDegraded, market: mkt })');
    expect(src).toContain('degraded: {');
  });

  it('agents: data-degraded signals NEVER auto-trade (Engine A + C gates)', () => {
    const a = readSrc('server/ai/agent.js');
    const i = readSrc('server/ai/indiaAgent.js');
    expect(a).toContain('if (s.dataDegraded) {');
    expect(a).toContain('auto-trade BLOCKED');
    expect(i).toContain('if (s.dataDegraded) continue;');
  });
});

describe('v21.23.4 — side-alias safety (silent-LONG-default removed)', () => {
  it('sideSignOf: canonical + exchange-vocab aliases map correctly', () => {
    expect(sideSignOf('LONG')).toBe(1);
    expect(sideSignOf('SHORT')).toBe(-1);
    expect(sideSignOf('BUY')).toBe(1);
    expect(sideSignOf('SELL')).toBe(-1);
    expect(sideSignOf(1)).toBe(1);
    expect(sideSignOf(-1)).toBe(-1);
  });

  it('sideSignOf: unknown side = null (honest refuse — pehle silent LONG tha)', () => {
    expect(sideSignOf('FLAT')).toBeNull();
    expect(sideSignOf('')).toBeNull();
    expect(sideSignOf(undefined)).toBeNull();
    expect(sideSignOf('SIDEWAYS-SOMETHING')).toBeNull();
  });

  it('buildSuperBlueprint: unknown side → null blueprint (no silent LONG geometry)', () => {
    const bp = buildSuperBlueprint({
      side: 'FLAT', ltp: 100, atr: 2, aiScore: 80, market: 'CRYPTO',
      stopLoss: 96, target1: 108, target2: 116,
    });
    expect(bp).toBeNull();
    const ok = buildSuperBlueprint({
      side: 'SHORT', ltp: 100, atr: 2, aiScore: 80, market: 'CRYPTO',
      stopLoss: 104, target1: 92, target2: 84,
    });
    expect(ok).toBeTruthy(); // SHORT blueprint polarity
    expect(ok!.stopLoss).toBeGreaterThan(ok!.entry);
  });
});

describe('v21.23.4 — RUNTIME DIRECTION CERTIFICATE (ground truth, not consistency)', () => {
  it('self-test PASSES end-to-end: rising→LONG · falling→SHORT · order bodies', () => {
    const r = runDirectionSelfTest();
    if (!r.pass) {
      const failed = r.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`);
      throw new Error(`direction certificate BROKEN:\n${failed.join('\n')}`);
    }
    expect(r.pass).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(10);
  });

  it('certificate is wired: route + boot + summary flag', () => {
    expect(fs.readFileSync(path.resolve('server/ai/routes.js'), 'utf8')).toContain("/api/ai/direction-selftest'");
    expect(fs.readFileSync(path.resolve('server/index.js'), 'utf8')).toContain('logDirectionSelfTestAtBoot');
  });
});

describe('v21.23.4 — UI removal pins (degraded chip + suppressed banner + button gates)', () => {
  it('SignalCard: DATA-DEGRADED chip + ALL execute buttons gated', () => {
    const src = readSrc('src/components/aitrading/SignalCard.tsx');
    expect(src).toContain('DATA-DEGRADED');
    expect(src).toContain('busy || invalid || !!signal.dataDegraded');
    expect(src).toContain('busy || !canLiveHere || invalid || !!signal.dataDegraded');
  });

  it('BreadthStrip (both desks): suppressed-symbols banner present', () => {
    const src = readSrc('src/components/aitrading/deskShared.tsx');
    expect(src).toContain('SUPPRESSED');
    expect(src).toContain('degraded');
  });

  it('types: dataDegraded/degradedReason on AISignal + degraded ledger on SignalBoard', () => {
    const t = readSrc('src/components/aitrading/types.ts');
    expect(t).toMatch(/dataDegraded\?: string \| null/);
    expect(t).toContain('degradedReason');
    expect(t).toContain('degraded?: { count: number');
  });
});

describe('v21.23.4 — store invariants (audit S1/S2 hardening)', () => {
  it('candleStore first-write sorts descending input before writing (reversed adapter can never poison the file)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
    const bars = [];
    const t0 = Date.now() - 10 * 60_000;
    for (let i = 0; i < 10; i++) {
      bars.push({ t: t0 + i * 60_000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 10 });
    }
    const reversed = [...bars].reverse(); // hostile caller order
    saveCandles(dir, 'TEST', 'XYZ', '1m', reversed, { source: 'hostile' });
    const { bars: loaded } = loadCandles(dir, 'TEST', 'XYZ', '1m');
    expect(loaded.length).toBe(10);
    for (let i = 1; i < loaded.length; i++) {
      expect(loaded[i].t).toBeGreaterThan(loaded[i - 1].t); // ascending on disk
    }
    expect(loaded[loaded.length - 1].c).toBe(109); // newest bar last
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('data.js Binance legs now sort locally (API-contract-free)', () => {
    expect(fs.readFileSync(path.resolve('server/ai/data.js'), 'utf8')).toContain("candles.sort((a, b) => a.time - b.time)");
  });
});
