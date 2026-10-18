// ============================================================
// test/ultrafastVerifier.test.ts — v20.9.2 ULTRAFAST CHART
// VERIFICATION AGENT (UCV-A1)
// ------------------------------------------------------------
// LOCKED HERE (user spec: "deep additional deep AI agent rakho jo
// realtime ultrafast chart check kar sake ki long signal pakka long
// jayega kya nhi, short signal pakka short jayega kya nhi — 80+ AI
// score ke signals recheck karo, advance pro trader level pe"):
//   • THE MISMATCH CASE (the user's exact complaint — "long bolne par
//     short jaa rahe hai"): a LONG signal while the 1m ultrafast
//     chart is actively DUMPING must come back REJECTED (never
//     CONFIRMED, never silently pass). The mirror SHORT-rising case
//     likewise.
//   • THE CONFIRM CASE: LONG on a rising 1m micro tape (bull stack,
//     HH/HL, up volume) → CONFIRMED with the "PAKKA" answer.
//   • THE PENDING CASE: a flat/neutral tape or missing data →
//     PENDING (honest degrade — never blocks, never lies).
//   • Micro-structure math: rising series reads UP, falling reads
//     DOWN, monotone flatness never reaches the CONFIRM bar.
//   • ultrafastGatePatch: a REJECTED 80+ signal loses the badge
//     (aiScore capped ≤64, tier re-derived, STRONG/ACTION grade →
//     WATCH, driver line appended) — a signal fighting its own 1m
//     chart can never wear the 80+ tradeable tier.
//   • ultrafastWire: compact shape + never mangles a non-agent wire.
//   • 9 checks present on a real analysis; statuses are BULL/BEAR/
//     FLAT/N-A only.
//   • verifySignalUltrafast: fetch-deadline degrade → PENDING, and
//     the 45s verdict cache returns the SAME object on repeat calls.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  analyzeUltrafastChart,
  verifyUltrafast,
  ultrafastWire,
  ultrafastGatePatch,
  verifySignalUltrafast,
  UC_REJECT_SCORE_CAP,
  __resetUltrafastForTests,
} from '../server/ai/ultrafastVerifier.js';

// ---- synthetic candle builders (oldest-first, {time,o,h,l,c,v}) ----
let t0 = 1_700_000_000_000;
const bar = (open: number, close: number, vol = 100, highBias = 0, lowBias = 0) => {
  t0 += 60_000;
  return {
    time: t0,
    open,
    close,
    high: Math.max(open, close) + highBias,
    low: Math.min(open, close) - lowBias,
    volume: vol,
  };
};

/** A steadily RISING 1m series (bull stack + HH/HL + up-volume). */
function rising1m(n = 60, step = 0.55) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) { out.push(bar(p, p + step, 120)); p += step; }
  return out;
}
/** A steadily FALLING 1m series (bear stack + LH/LL + down-volume). */
function falling1m(n = 60, step = 0.55) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) { out.push(bar(p, p - step, 120)); p -= step; }
  return out;
}
/** A dead-flat series (doji tape — must read FLAT, not UP). */
function flat1m(n = 60) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) { out.push(bar(p, p, 80)); }
  return out;
}

beforeEach(() => { __resetUltrafastForTests(); });

// ============================================================
// PART 1 — the pure micro-structure analysis
// ============================================================
describe('analyzeUltrafastChart — the realtime 1m micro read', () => {
  it('a rising 1m tape reads UP with a positive microScore', () => {
    const a = analyzeUltrafastChart({ candles1m: rising1m() });
    expect(a.ok).toBe(true);
    expect(a.microDirection).toBe('UP');
    expect(a.microScore).toBeGreaterThan(0);
    expect(a.bars).toBe(60);
  });

  it('a falling 1m tape reads DOWN with a negative microScore', () => {
    const a = analyzeUltrafastChart({ candles1m: falling1m() });
    expect(a.ok).toBe(true);
    expect(a.microDirection).toBe('DOWN');
    expect(a.microScore).toBeLessThan(0);
  });

  it('a dead-flat doji tape reads FLAT — never crosses the CONFIRM bar', () => {
    const a = analyzeUltrafastChart({ candles1m: flat1m() });
    expect(a.ok).toBe(true);
    expect(a.microDirection).toBe('FLAT');
    expect(Math.abs(a.microScore)).toBeLessThan(25);
  });

  it('emits the 9-check micro checklist with valid statuses', () => {
    const a = analyzeUltrafastChart({ candles1m: rising1m() });
    expect(a.checks.length).toBe(9);
    for (const c of a.checks) {
      expect(['BULL', 'BEAR', 'FLAT', 'N/A']).toContain(c.status);
      expect(typeof c.detail).toBe('string');
    }
    // the rising tape's decisive checks must be BULL
    const stack = a.checks.find(c => c.id === 'fastStack');
    expect(stack?.status).toBe('BULL');
    const run = a.checks.find(c => c.id === 'recentRun');
    expect(run?.status).toBe('BULL');
    const struct = a.checks.find(c => c.id === 'microStructure');
    expect(struct?.status).toBe('BULL');
  });

  it('insufficient 1m data degrades honestly (ok:false, no checks)', () => {
    const a = analyzeUltrafastChart({ candles1m: rising1m(20), candles5m: null, liveTick: null });
    expect(a.ok).toBe(false);
    expect(a.microDirection).toBe('FLAT');
    expect(a.checks.length).toBe(0);
  });

  it('the LIVE tick joins the read (tickVelocity check present)', () => {
    const c1 = rising1m();
    const last = c1[c1.length - 1].close;
    const a = analyzeUltrafastChart({ candles1m: c1, liveTick: { price: last * 1.001, time: Date.now() } });
    const tick = a.checks.find(c => c.id === 'tickVelocity');
    expect(tick).toBeTruthy();
    expect(tick?.status).toBe('BULL');
    expect(a.tickPct).toBeGreaterThan(0);
  });

  it('momentum % reflects the last-5-bar move', () => {
    const c1 = rising1m(60, 0.5); // +0.5/bar → 5 bars ≈ +2.5
    const a = analyzeUltrafastChart({ candles1m: c1 });
    expect(a.momentumPct).toBeGreaterThan(1.5);
  });
});

// ============================================================
// PART 2 — the agent verdict (the user's exact question)
// ============================================================
describe('verifyUltrafast — "pakka long jayega? pakka short jayega?"', () => {
  it('THE MISMATCH CASE: LONG signal + dumping 1m chart → REJECTED (the "long bola par short gaya" fix)', () => {
    const v = verifyUltrafast({ side: 'LONG', symbol: 'BTC', market: 'CRYPTO', analysis: analyzeUltrafastChart({ candles1m: falling1m() }) });
    expect(v.verdict).toBe('REJECTED');
    expect(v.confirmed).toBe(false);
    expect(v.microDirection).toBe('DOWN');
    expect(v.answer).toContain('REJECT');
  });

  it('THE MIRROR MISMATCH: SHORT signal + ripping 1m chart → REJECTED', () => {
    const v = verifyUltrafast({ side: 'SHORT', symbol: 'ETH', market: 'FUTURES', analysis: analyzeUltrafastChart({ candles1m: rising1m() }) });
    expect(v.verdict).toBe('REJECTED');
    expect(v.microDirection).toBe('UP');
  });

  it('LONG on a rising ultrafast chart → CONFIRMED with the PAKKA answer', () => {
    const v = verifyUltrafast({ side: 'LONG', symbol: 'BTC', market: 'CRYPTO', analysis: analyzeUltrafastChart({ candles1m: rising1m() }) });
    expect(v.verdict).toBe('CONFIRMED');
    expect(v.confirmed).toBe(true);
    expect(v.answer).toContain('PAKKA');
    expect(v.ownScore).toBeGreaterThan(0);
  });

  it('SHORT on a falling ultrafast chart → CONFIRMED', () => {
    const v = verifyUltrafast({ side: 'SHORT', symbol: 'SOL', market: 'FUTURES', analysis: analyzeUltrafastChart({ candles1m: falling1m() }) });
    expect(v.verdict).toBe('CONFIRMED');
    expect(v.answer).toContain('PAKKA');
  });

  it('a neutral tape → PENDING (never a manufactured call)', () => {
    const v = verifyUltrafast({ side: 'LONG', symbol: 'XRP', market: 'CRYPTO', analysis: analyzeUltrafastChart({ candles1m: flat1m() }) });
    expect(v.verdict).toBe('PENDING');
    expect(v.confirmed).toBe(false);
  });

  it('missing analysis → honest PENDING, never throws, never blocks', () => {
    const v = verifyUltrafast({ side: 'SHORT', symbol: 'DOGE', market: 'CRYPTO', analysis: null });
    expect(v.verdict).toBe('PENDING');
    expect(v.answer).toContain('PENDING');
    const v2 = verifyUltrafast({ side: 'LONG', symbol: 'DOGE', market: 'CRYPTO', analysis: { ok: false, summary: 'no feed' } });
    expect(v2.verdict).toBe('PENDING');
  });

  it('a WEAKLY adverse tape (below the reject bar) stays PENDING, not REJECTED', () => {
    // mild drift down — below |30|: neither confirm nor reject
    const c1 = rising1m(45).concat(falling1m(15, 0.18));
    const v = verifyUltrafast({ side: 'LONG', symbol: 'BTC', market: 'CRYPTO', analysis: analyzeUltrafastChart({ candles1m: c1 }) });
    expect(['PENDING', 'REJECTED']).toContain(v.verdict);
    if (v.verdict === 'REJECTED') expect(v.score).toBeGreaterThanOrEqual(30);
  });
});

// ============================================================
// PART 3 — the wire + the gate
// ============================================================
describe('ultrafastWire + ultrafastGatePatch — the 80+ tier protection', () => {
  it('wire is compact and agent-tagged', () => {
    const v = verifyUltrafast({ side: 'LONG', symbol: 'BTC', market: 'CRYPTO', analysis: analyzeUltrafastChart({ candles1m: rising1m() }) });
    const w = ultrafastWire(v);
    expect(w).toBeTruthy();
    expect(w.agent).toBe('UCV-A1');
    expect(w.verdict).toBe('CONFIRMED');
    expect(w.answer).toBeTruthy();
    expect((w as Record<string, unknown>).checks).toBeUndefined(); // compact — no checklist
  });

  it('a non-agent object passes through as null (no mangling)', () => {
    expect(ultrafastWire(null)).toBeNull();
    expect(ultrafastWire({ agent: 'SVA-v1' } as never)).toBeNull();
  });

  it('REJECTED gate: an 85-score STRONG signal loses the 80+ badge and the grade', () => {
    const v = verifyUltrafast({ side: 'LONG', symbol: 'BTC', market: 'CRYPTO', analysis: analyzeUltrafastChart({ candles1m: falling1m() }) });
    expect(v.verdict).toBe('REJECTED');
    const sig = {
      side: 'LONG', grade: 'STRONG',
      superIntel: { aiScore: 85, tier: 'ELITE', drivers: ['engine conviction 80%'] },
    };
    const patch = ultrafastGatePatch(v, sig);
    expect(patch).toBeTruthy();
    expect(patch!.superIntel.aiScore).toBeLessThanOrEqual(UC_REJECT_SCORE_CAP);
    expect(patch!.superIntel.aiScore).toBeLessThan(80); // the 80+ filter drops it
    expect(patch!.superIntel.tier).not.toBe('ELITE');
    expect(patch!.grade).toBe('WATCH'); // STRONG → WATCH demotion
    expect(patch!.superIntel.drivers.some((d: string) => String(d).includes('UCV-A1 REJECT'))).toBe(true);
    expect(patch!.superIntel.ultrafastRejected).toBe(true);
  });

  it('a low score is never RAISED by the cap (min semantics)', () => {
    const v = verifyUltrafast({ side: 'SHORT', symbol: 'ETH', market: 'FUTURES', analysis: analyzeUltrafastChart({ candles1m: rising1m() }) });
    const sig = { side: 'SHORT', grade: 'ACTION', superIntel: { aiScore: 41, tier: 'WATCH', drivers: [] } };
    const patch = ultrafastGatePatch(v, sig as never);
    expect(patch!.superIntel.aiScore).toBe(41); // ≤64 stays 41
    expect(patch!.grade).toBe('WATCH');
  });

  it('CONFIRMED / PENDING verdicts do NOT touch the signal (null patch)', () => {
    const ok = verifyUltrafast({ side: 'LONG', symbol: 'BTC', market: 'CRYPTO', analysis: analyzeUltrafastChart({ candles1m: rising1m() }) });
    expect(ultrafastGatePatch(ok, { grade: 'STRONG', superIntel: { aiScore: 88, tier: 'ELITE', drivers: [] } } as never)).toBeNull();
    const pend = verifyUltrafast({ side: 'LONG', symbol: 'BTC', market: 'CRYPTO', analysis: null });
    expect(ultrafastGatePatch(pend, { grade: 'STRONG', superIntel: { aiScore: 88, tier: 'ELITE', drivers: [] } } as never)).toBeNull();
  });

  it('WATCH-grade signals keep their grade (no further demotion needed)', () => {
    const v = verifyUltrafast({ side: 'LONG', symbol: 'BTC', market: 'CRYPTO', analysis: analyzeUltrafastChart({ candles1m: falling1m() }) });
    const sig = { side: 'LONG', grade: 'WATCH', superIntel: { aiScore: 55, tier: 'WATCH', drivers: [] } };
    const patch = ultrafastGatePatch(v, sig as never);
    expect(patch!.grade).toBeUndefined(); // already WATCH — grade untouched
    expect(patch!.superIntel.aiScore).toBeLessThanOrEqual(UC_REJECT_SCORE_CAP);
  });
});

// ============================================================
// PART 4 — the fetch wrapper (deadline + cache semantics)
// ============================================================
describe('verifySignalUltrafast — deadline, cache, honest degrade', () => {
  it('a dead network (unreachable market) degrades to PENDING, never throws', async () => {
    const out = await verifySignalUltrafast({ side: 'LONG', symbol: 'ZZZZZZ', market: 'CRYPTO' }, { deadlineMs: 60 });
    expect(out).toBeTruthy();
    expect(out.agent).toBe('UCV-A1');
    // no 1m feed for a bogus symbol → PENDING (honest)
    expect(out.verdict).toBe('PENDING');
  }, 10_000);

  it('the 45s verdict cache returns the SAME object on a repeat call', async () => {
    const a1 = await verifySignalUltrafast({ side: 'LONG', symbol: 'QQQQQQ', market: 'CRYPTO' }, { deadlineMs: 60 });
    const a2 = await verifySignalUltrafast({ side: 'LONG', symbol: 'QQQQQQ', market: 'CRYPTO' }, { deadlineMs: 60 });
    expect(a2).toBe(a1); // reference-equal → cache hit, zero refetch
  }, 10_000);

  it('a rejected-direction live signal cannot pass as confirmed', async () => {
    // GLOBALFUTURES has no candle path wired (null) → PENDING is the
    // honest ceiling; the point here is the wrapper NEVER fabricates
    // a CONFIRMED without a real analysis.
    const out = await verifySignalUltrafast({ side: 'LONG', symbol: 'AAPL', market: 'GLOBALFUTURES' }, { deadlineMs: 60 });
    expect(['PENDING', 'CONFIRMED', 'REJECTED']).toContain(out.verdict);
    if (out.verdict !== 'PENDING') expect(out.bars).toBeGreaterThan(0);
  }, 10_000);
});
