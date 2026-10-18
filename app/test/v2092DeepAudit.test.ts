// ============================================================
// test/v2092DeepAudit.test.ts — v20.9.2 ULTRAFAST CHART
// VERIFICATION AGENT + DIRECTION-MISMATCH FIX
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "Trade signals bahut mismatch ho rahe
// hai — long bolne par short jaa rahe hai, short bolne par long.
// Deep additional AI agent rakho jo realtime ultrafast chart check
// kar sake ki long signal pakka long jayega kya nhi, short signal
// pakka short jayega kya nhi. 80+ AI Score ke signals recheck karo —
// advance pro trader level pe."
//
// This lock-set pins the FULL wiring chain of the new UCV-A1 layer:
//   1. signals.js board — the 80+ / STRONG tier runs the ultrafast
//      recheck (top-6/cycle) and REJECTED → aiScore cap + grade demote
//   2. signals.js deep path — the FULL payload (checks ride along)
//   3. proTraderAuto gate — a REJECTED direction can NEVER auto-enter
//   4. signalRecheck loop — UC_REJECTED / UC_CONFIRMED transition
//      events + the row view carries the verdict
//   5. cryptoAgent verify_signal tool — cites BOTH SVA + UCV verdicts
//   6. frontend — types + the ⚡ badge + the micro-checklist render
// Mix: functional tests (pure verifier) + source contracts (wiring jo
// sirf source-grep se lock hota hai — repo ka established pattern).
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = (p: string) => readFileSync(path.join(APP, p), 'utf8');
const src = {
  verifier: S('server/ai/ultrafastVerifier.js'),
  signals: S('server/ai/signals.js'),
  recheck: S('server/ai/signalRecheck.js'),
  proTrader: S('server/ai/proTraderAuto.js'),
  cryptoAgent: S('server/ai/cryptoAgent.js'),
  signalCard: S('src/components/aitrading/SignalCard.tsx'),
  types: S('src/components/aitrading/types.ts'),
  pkg: JSON.parse(S('package.json')),
};

// ---- the pure agent (functional) ----
import {
  analyzeUltrafastChart,
  verifyUltrafast,
  ultrafastGatePatch,
  UC_REJECT_SCORE_CAP,
} from '../server/ai/ultrafastVerifier.js';

const bars = (n: number, step: number) => {
  const out = [];
  let p = 100;
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    t += 60_000;
    const o = p;
    const c = p + step;
    out.push({ time: t, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 100 });
    p = c;
  }
  return out;
};

describe('v20.9.2 — THE MISMATCH FIX (the user\'s exact complaint)', () => {
  it('LONG signal + dumping ultrafast chart → REJECTED (long bola par short gaya class)', () => {
    const a = analyzeUltrafastChart({ candles1m: bars(60, -0.55) });
    expect(a.microDirection).toBe('DOWN');
    const v = verifyUltrafast({ side: 'LONG', analysis: a });
    expect(v.verdict).toBe('REJECTED');
    expect(v.answer).toMatch(/REJECT/);
  });

  it('SHORT signal + ripping ultrafast chart → REJECTED (mirror)', () => {
    const a = analyzeUltrafastChart({ candles1m: bars(60, 0.55) });
    expect(a.microDirection).toBe('UP');
    const v = verifyUltrafast({ side: 'SHORT', analysis: a });
    expect(v.verdict).toBe('REJECTED');
  });

  it('REJECTED → 80+ badge + STRONG/ACTION grade lost (the gate patch)', () => {
    const v = verifyUltrafast({ side: 'LONG', analysis: analyzeUltrafastChart({ candles1m: bars(60, -0.55) }) });
    const patch = ultrafastGatePatch(v, {
      side: 'LONG', grade: 'STRONG',
      superIntel: { aiScore: 86, tier: 'ELITE', drivers: [] },
    } as never);
    expect(patch).toBeTruthy();
    expect(patch!.superIntel.aiScore).toBeLessThanOrEqual(UC_REJECT_SCORE_CAP);
    expect(patch!.grade).toBe('WATCH');
  });
});

// ---- the wiring chain (source contracts) ----
describe('v20.9.2 — the UCV-A1 wiring chain', () => {
  it('signals.js: the agent module is imported', () => {
    expect(src.signals).toMatch(/from '\.\/ultrafastVerifier\.js'/);
    expect(src.signals).toMatch(/verifySignalUltrafast/);
    expect(src.signals).toMatch(/ultrafastGatePatch/);
    expect(src.signals).toMatch(/ultrafastWire/);
  });

  it('signals.js BOARD: 80+ AI-score / STRONG tier runs the recheck (top-6 bound)', () => {
    expect(src.signals).toMatch(/superIntel\.aiScore\) >= 80 \|\| s\.grade === 'STRONG'/);
    expect(src.signals).toMatch(/slice\(0, 6\)/);
    // REJECTED applies the patch: aiScore + grade + flag
    expect(src.signals).toMatch(/s\.superIntel = patch\.superIntel/);
    expect(src.signals).toMatch(/s\.ucRejected = true/);
  });

  it('signals.js DEEP: full payload attached (checks ride along)', () => {
    expect(src.signals).toMatch(/built\.ultrafast = uvD; \/\/ FULL payload/);
  });

  it('proTraderAuto: a REJECTED direction blocks the auto-entry (execution-side lock)', () => {
    expect(src.proTrader).toMatch(/uc\?\.verdict === 'REJECTED'/);
    expect(src.proTrader).toMatch(/ultrafast:REJECTED/);
  });

  it('signalRecheck: UC transition events + row view carry the verdict', () => {
    expect(src.recheck).toMatch(/UC_REJECTED/);
    expect(src.recheck).toMatch(/UC_CONFIRMED/);
    expect(src.recheck).toMatch(/ultrafastVerdict/);
    expect(src.recheck).toMatch(/ultrafastAnswer/);
  });

  it('cryptoAgent verify_signal: cites BOTH SVA + UCV verdicts', () => {
    expect(src.cryptoAgent).toMatch(/ULTRAFAST_CHART_VERDICT/);
    expect(src.cryptoAgent).toMatch(/UCV-A1/);
  });

  it('frontend: types + badge + micro-checklist render', () => {
    expect(src.types).toMatch(/interface UltrafastVerification/);
    expect(src.types).toMatch(/ultrafast\?: UltrafastVerification \| null/);
    expect(src.signalCard).toMatch(/function UltrafastBadge/);
    expect(src.signalCard).toMatch(/function UltrafastChecklist/);
    expect(src.signalCard).toMatch(/signal\.ultrafast && <UltrafastBadge/);
    expect(src.signalCard).toMatch(/signal\.ultrafast && <UltrafastChecklist/);
  });

  it('version sync release gate wired (package.json === APP_VERSION, dynamic — stale-pin khatam) [v20.9.4]', () => {
    // [v20.9.4] hard-pin har bump pe stale hota tha — ab cross-consistency check
    const m = S('src/version.ts').match(/APP_VERSION = '([^']+)'/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(src.pkg.version);
  });

  it('cost discipline: deadline + verdict cache + honest degrade are all present', () => {
    expect(src.verifier).toMatch(/deadlineMs/);
    expect(src.verifier).toMatch(/UC_CACHE_TTL_MS = 45_000/);
    expect(src.verifier).toMatch(/PENDING/); // the honest degrade verdict
    // candles ride the EXISTING TTL cache chain — no new fetch layer
    expect(src.verifier).toMatch(/fetchCoinDcxCandles/);
    expect(src.verifier).toMatch(/fetchBinanceKlines/);
  });
});
