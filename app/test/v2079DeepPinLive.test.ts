// ============================================================
// test/v2079DeepPinLive.test.ts — v20.7.9 DEEP-PIN + ULTRAFAST INDIA
// ------------------------------------------------------------
// THE SYMPTOM (user): "Superintelligence Signal Board ka trade signal
// aur DEEP ENSEMBLE ANALYSIS ka data alag hai — score, details sab
// kuch alag. Aisa kyun?"
//
// ROOT CAUSE: a 🔬 click threw away the clicked signal and rendered
// only a freshly-recomputed ensemble. The board card was scanned up
// to ~90s earlier, so the live re-run legitimately read different
// scores / grades / even sides — correct, but it read as a mismatch.
//
// THE CONTRACT (locked here):
//   PIN ENGINE (behavioral, pure):
//   [P1] deepPinVerdict: same side + within tolerance → CONFIRMED
//   [P2] deepPinVerdict: same side + |Δconf| ≥ 8 → DRIFTED
//   [P3] deepPinVerdict: same side + grade change → DRIFTED (dir)
//   [P4] deepPinVerdict: opposite side → FLIPPED (thesis dead)
//   [P5] deepPinVerdict: same side + entry moved ≥ 1.5% → DRIFTED
//   [P6] deepPinVerdict: same side + |Δ AI score| ≥ 8 → DRIFTED
//   [P7] deepPinVerdict: small drifts (< 8 conf, < 1.5% entry) → CONFIRMED
//   [P8] isPinnableSignal: Expert/Top-picks stub ({symbol,market} cast)
//        is NOT pinnable — full board signal IS
//
//   WIRING (source-contract, routeMount precedent):
//   [W1] BOTH tabs pin the clicked signal (isPinnableSignal gate)
//   [W2] BOTH tabs render DeepPinnedCompare under the primary card
//   [W3] BOTH tabs render the pinned card DURING loading (no blank
//        🧠 swap) and on live-run FAILURE (click context survives)
//   [W4] useDeepAutoRecheck preserves `pinned` (functional setDeep —
//        a plain replacement object would un-pin on the first 15s
//        recheck and re-create the mismatch)
//   [W5] INDIA tab rides the 3s ultrafast push stream
//        (/api/stream?in=… via useCxLivePrices) with the 5s watcher
//        as fallback — push tick WINS on freshness
//   [W6] INDIA deep modal SignalCard gets liveLtp/liveSrc (frozen
//        snapshot price was shown before)
//   [W7] server registers the FULL board (slice 15) with the
//        intraday watcher — the 15th card no longer misses live LTP
//   [W8] BOTH tabs' error paths keep the pinned card visible with
//        the honest "live re-verification unavailable" strip
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepPinVerdict, isPinnableSignal } from '../src/components/aitrading/deepAnalysisExtras';
import type { AISignal } from '../src/components/aitrading/types';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// ---- signal factory (minimal honest shape deepPinVerdict reads) ----
const sig = (over: Partial<AISignal>): AISignal => ({
  symbol: 'ETH', market: 'CRYPTO', side: 'LONG', grade: 'STRONG',
  confidence: 78, agreement: 0.72, participating: 9, totalModels: 12,
  ltp: 300000, changePct: 1.2, plan: {
    entry: 300000, stopLoss: 295000, target1: 308000, target2: 315000,
    rewardRisk: 1.6, atrUsed: 2400, qty: 0.01, riskINR: 500,
  } as AISignal['plan'],
  ...over,
} as AISignal);

describe('v20.7.9 [P1-P7] deepPinVerdict — the pure ORIGINAL-vs-LIVE engine', () => {
  it('[P1] same side, same numbers → CONFIRMED', () => {
    const v = deepPinVerdict(sig({}), sig({ confidence: 76 })); // −2 conf: within tolerance
    expect(v.verdict).toBe('CONFIRMED');
    expect(v.sameSide).toBe(true);
    expect(v.gradeDir).toBe('flat');
  });

  it('[P2] same side, confidence −10 → DRIFTED (conf drift flagged)', () => {
    const v = deepPinVerdict(sig({ confidence: 80 }), sig({ confidence: 70 }));
    expect(v.verdict).toBe('DRIFTED');
    expect(v.confDrift).toBe(-10);
  });

  it('[P3] same side, STRONG → ACTION → DRIFTED with gradeDir down', () => {
    const v = deepPinVerdict(sig({ grade: 'STRONG' }), sig({ grade: 'ACTION', confidence: 78 }));
    expect(v.verdict).toBe('DRIFTED');
    expect(v.gradeDir).toBe('down');
  });

  it('[P4] opposite side → FLIPPED — the thesis is dead', () => {
    const v = deepPinVerdict(sig({ side: 'LONG' }), sig({ side: 'SHORT' }));
    expect(v.verdict).toBe('FLIPPED');
    expect(v.sameSide).toBe(false);
  });

  it('[P5] same side, entry moved 3% → DRIFTED (levels must be re-read)', () => {
    const live = sig({ plan: { ...sig({}).plan!, entry: 309000 } as AISignal['plan'] });
    const v = deepPinVerdict(sig({}), live);
    expect(v.verdict).toBe('DRIFTED');
  });

  it('[P6] same side, AI score −12 → DRIFTED', () => {
    const pin = sig({ superIntel: { aiScore: 82 } as AISignal['superIntel'] });
    const live = sig({ superIntel: { aiScore: 70 } as AISignal['superIntel'] });
    const v = deepPinVerdict(pin, live);
    expect(v.verdict).toBe('DRIFTED');
    expect(v.aiScoreDrift).toBe(-12);
  });

  it('[P7] small drifts stay CONFIRMED — −5 conf, −5 AI score, 0.5% entry', () => {
    const pin = sig({ confidence: 80, superIntel: { aiScore: 80 } as AISignal['superIntel'] });
    const live = sig({
      confidence: 75,
      superIntel: { aiScore: 75 } as AISignal['superIntel'],
      plan: { ...sig({}).plan!, entry: 301500 } as AISignal['plan'], // +0.5%
    });
    const v = deepPinVerdict(pin, live);
    expect(v.verdict).toBe('CONFIRMED');
  });

  it('plan extraction carries entry/SL/T1/T2 for both columns', () => {
    const v = deepPinVerdict(sig({}), sig({}));
    expect(v.planPinned).toMatchObject({ entry: 300000, sl: 295000, t1: 308000, t2: 315000 });
    expect(v.planLive).toMatchObject({ entry: 300000, sl: 295000, t1: 308000, t2: 315000 });
  });

  it('FLIPPED note warns against entry (Hinglish contract)', () => {
    const v = deepPinVerdict(sig({ side: 'LONG' }), sig({ side: 'SHORT' }));
    expect(v.note).toMatch(/valid NAHI/i);
  });
});

describe('v20.7.9 [P8] isPinnableSignal — the pin gate', () => {
  it('a full board signal is pinnable', () => {
    expect(isPinnableSignal(sig({}))).toBe(true);
  });

  it('the Expert/Top-picks stub ({symbol, market} cast) is NOT pinnable', () => {
    expect(isPinnableSignal({ symbol: 'ETH', market: 'CRYPTO' } as AISignal)).toBe(false);
  });

  it('null / undefined never pin', () => {
    expect(isPinnableSignal(null)).toBe(false);
    expect(isPinnableSignal(undefined)).toBe(false);
  });
});

describe('v20.7.9 [W1-W8] wiring source-contracts', () => {
  const cx = () => src('src/components/tabs/CoinDcxTab.tsx');
  const inTab = () => src('src/components/tabs/IndiaIntradayTab.tsx');
  const extras = () => src('src/components/aitrading/deepAnalysisExtras.tsx');
  const routes = () => src('server/ai/routes.js');

  it('[W1] BOTH tabs pin the clicked signal through isPinnableSignal', () => {
    for (const s of [cx(), inTab()]) {
      expect(s).toMatch(/const pin = isPinnableSignal\(signal\) \? signal : null;/);
      expect(s).toMatch(/setDeep\(\{ loading: true, pinned: pin, pinnedAt: pin \? Date\.now\(\) : null \}\)/);
    }
  });

  it('[W2] BOTH tabs render DeepPinnedCompare under the primary card (v20.7.12: deepCardSig — verdict-routed, pinned-first)', () => {
    for (const s of [cx(), inTab()]) {
      expect(s).toMatch(/<DeepPinnedCompare pinned=\{deep\.pinned\} pinnedAt=\{deep\.pinnedAt\} live=\{deep\.signal\} recheckedAt=\{deep\.recheckedAt\} \/>/);
      // v20.7.12 [H3-3]: primary card ab verdict-routed hai — CONFIRMED pe
      // pinned, DRIFTED pe LIVE (fresh numbers), FLIPPED/UNKNOWN pe pinned
      // reference (execute band). deepCardSig = deepExecSig ?? deepPrimary.
      expect(s).toMatch(/const deepCardSig = deepExecSig \?\? deepPrimary/);
      expect(s).toMatch(/\{deepCardSig && \(/);
      // FLIPPED pe execute handlers jaate hain (dead thesis se trade nahi)
      expect(s).toMatch(/deepPinV\?\.verdict === 'FLIPPED'/);
    }
  });

  it('[W3] BOTH tabs render the pinned card DURING loading', () => {
    for (const s of [cx(), inTab()]) {
      const loadingBlock = s.slice(s.indexOf('{deep.loading && ('), s.indexOf('{!deep.loading && deep.error'));
      expect(loadingBlock).toContain('LIVE RE-VERIFICATION');
      expect(loadingBlock).toMatch(/<SignalCard signal=\{deep\.pinned\}/);
    }
  });

  it('[W4] useDeepAutoRecheck preserves pinned via functional setDeep', () => {
    const s = extras();
    expect(s).toMatch(/setDeep\(prev => prev \? \{\s*\.\.\.prev,/);
    // the OLD shape (whole-object replacement dropping pinned) must be gone
    expect(s).not.toMatch(/setDeep\(\{ loading: false, signal: now,/);
  });

  it('[W5] INDIA tab rides the 3s push stream with the watcher as fallback', () => {
    const s = inTab();
    expect(s).toMatch(/useCxLivePrices\(true, \[\], \[\], \[\], indiaPushSyms\)/);
    // push tick wins; 5s watcher quote is the fallback leg
    expect(s).toMatch(/const push = pushFor\('INDIA', sym\);/);
    expect(s).toMatch(/if \(push && push\.price > 0\) \{/);
    expect(s).toMatch(/const q = stream\.livePrices\[sym\];/);
  });

  it('[W6] INDIA deep modal SignalCard gets liveLtp + liveSrc (A2 fix; v20.7.12 ek hi liveFor call — deepCardTick)', () => {
    const s = inTab();
    const modal = s.slice(s.indexOf('DEEP ANALYSIS MODAL'));
    expect(modal).toMatch(/liveLtp=\{deepCardTick\?\.price \?\? null\}/);
    expect(modal).toMatch(/liveSrc=\{deepCardTick\?\.src \?\? null\}/);
    expect(s).toMatch(/const deepCardTick = deepCardSig \? liveFor\(deepCardSig\.symbol\) : null/);
  });

  it('[W7] server registers the FULL board (slice 15) with the intraday watcher', () => {
    expect(routes()).toMatch(/board\.signals\.slice\(0, 15\)/);
    expect(routes()).not.toMatch(/board\.signals\.slice\(0, 14\)/);
  });

  it('[W8] BOTH tabs keep the pinned card visible when the live re-run FAILS', () => {
    for (const s of [cx(), inTab()]) {
      // lastIndexOf: the header's freshness chip also opens with
      // {!deep.loading && deep.signal — the modal BODY block is the last.
      const failBlock = s.slice(s.indexOf('deep.error && deep.pinned'), s.lastIndexOf('{!deep.loading && deep.signal && ('));
      expect(failBlock).toMatch(/<SignalCard signal=\{deep\.pinned\}/);
      expect(failBlock).toMatch(/Live re-verification abhi unavailable/);
    }
  });

  it('CoinDCX deep modal chart overlays the LIVE ltp (not the frozen snapshot)', () => {
    const s = cx();
    expect(s).toMatch(/ltp=\{liveFor\(deep\.signal\.market, deep\.signal\.symbol\)\?\.price \?\? deep\.signal\.ltp\}/);
  });

  it('DeepModalState carries pinned + pinnedAt (the state contract)', () => {
    const s = extras();
    expect(s).toMatch(/pinned\?: AISignal \| null;/);
    expect(s).toMatch(/pinnedAt\?: number \| null;/);
  });
});
