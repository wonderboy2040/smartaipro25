// ============================================================
// test/optionSignalCards.test.ts — v9.4 F&O OPTION SIGNAL CARDS
// regression suite.
//
// Locks the user's EXACT requested format end-to-end:
//   Stock name : Nifty50 17Sep 23400 CE
//   Target     : 110.00   (premium)
//   Entry (Buy): 86.50
//   Stop Loss  : 77.00
//
// Guards (BUY premium semantics — SL < entry < target ALWAYS):
//   1. name format: <display> <DDMon> <strike> <CE|PE>
//   2. LONG consensus → CE card · SHORT → PE card (direction lock)
//   3. levels: index-plan→premium (BS re-price) or premium-based
//      fallback — ordering invariant holds either way
//   4. max premium loss capped at 65%
//   5. weekly expiry schedule: NIFTY=Tuesday, SENSEX=Thursday
//      (v9.6 fix — v9.4 had it backwards; the trader's live broker
//      terminal is ground truth: Nifty weekly 15Sep hi hai, 17Sep ka
//      Nifty contract exists hi nahi)
//   6. NEUTRAL/FLAT consensus → NO directional card (honest)
//   7. SENSEX desk works off the BS model with correct step/lot
//   8. v9.6: ATM+ITM+OTM candidates, AI-scored, ranked, agent-bar
//      tradeable flag, POP/breakeven/exit-plan pro layer
// All hermetic — no network. Pure functions under test.
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildOptionSignalCards, expiryLabel, buildSyntheticChain, STRIKE_STEPS, LOT_SIZES, nextWeeklyExpiryFor } from '../server/ai/optionsDesk.js';
import { nextWeeklyExpiry, yearsToExpiry } from '../server/ai/lib/blackScholes.js';

// ------------------------------------------------------------
// Runtime expiry helpers (v10.5.2 de-rot): the hardcoded
// '2026-09-15' / '2026-09-17' expiries were TIME BOMBS — the moment
// that weekly expired (T ≤ 0), buildSyntheticChain returned null and
// the whole file went red. Live-clock tests now derive FUTURE dates:
//   • nextWeekly() → the real next NIFTY TUESDAY weekly (lib fn, IST-aware)
//   • nextSensex() → the real next SENSEX THURSDAY weekly
//   • istDateOut(n) → IST calendar date ~n days out. Its 15:30 IST
//     anchor is ALWAYS in the future (T ∈ (~n−1, ~n] days on any run
//     date/time), giving a controlled time-to-expiry window for the
//     parity assertions.
// ------------------------------------------------------------
const nextWeekly = () => nextWeeklyExpiry(new Date(), 2);
const nextSensex = () => nextWeeklyExpiry(new Date(), 4);
function istDateOut(days: number) {
  const ist = new Date(Date.now() + days * 86400000 + 5.5 * 3600000);
  return ist.toISOString().slice(0, 10);
}

// A desk shaped exactly like getOptionsDesk() serves it (bs-model
// branch — rows carry the BS premiums the card must translate).
const mkDesk = (symbol, spot, expiry, overrides = {}) => ({
  ok: true, symbol, spot, expiry, dte: 4, lotSize: LOT_SIZES[symbol] || 1,
  source: 'bs-model', syntheticNote: 'model chain',
  rows: buildSyntheticChain(symbol, spot, 0.13, expiry, 8)?.rows || [],
  ...overrides,
});

// A deep-signal payload like getDeepSignal('NIFTY') returns for a
// LONG index consensus with a plan.
const mkDeep = (side, plan) => ({
  ok: true,
  signal: {
    symbol: 'NIFTY', side, confidence: 74, grade: 'ACTION', agreement: 0.7,
    ...(plan ? { plan } : {}),
  },
});

describe('v9.4/v9.6 F&O option signal cards — the user format', () => {
  const EXPIRY = nextWeekly(); // the real next NIFTY Tuesday weekly (runtime — no date rot)
  const NIFTY_SPOT = 23411;
  const desk = mkDesk('NIFTY', NIFTY_SPOT, EXPIRY);
  // v9.6: cards are ranked candidates — grab the ATM one for the
  // classic single-contract assertions.
  const atmOf = (cards) => cards.find(x => x.strikeBias === 'ATM') ?? cards[0];

  it('names the card exactly "<display> <DDMon> <strike> <CE|PE>" (Nifty50 15Sep 23400 CE)', () => {
    const cards = buildOptionSignalCards(desk, mkDeep('LONG', { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT - 90, target1: NIFTY_SPOT + 120, target2: NIFTY_SPOT + 240 }));
    // v9.6: THREE ranked candidates (ATM + ITM + OTM) per index
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards.length).toBeLessThanOrEqual(3);
    const c = atmOf(cards);
    expect(c.type).toBe('CE');
    // strike must be ATM (nearest 50-step to 23411 → 23400)
    expect(c.strike).toBe(23400);
    // label is runtime-derived now (16Sep, 23Sep, …) — lock the exact
    // <display> <DDMon> <strike> <CE|PE> shape with the live label
    expect(c.name).toBe(`Nifty50 ${expiryLabel(EXPIRY)} 23400 CE`);
    expect(expiryLabel(EXPIRY)).toMatch(/^\d{2}[A-Z][a-z]{2}$/);
  });

  it('LONG consensus → CE · SHORT consensus → PE (direction lock)', () => {
    const long = buildOptionSignalCards(desk, mkDeep('LONG', { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT - 90, target1: NIFTY_SPOT + 120 }));
    const shortDesk = mkDesk('NIFTY', NIFTY_SPOT, EXPIRY);
    const short = buildOptionSignalCards(shortDesk, mkDeep('SHORT', { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT + 90, target1: NIFTY_SPOT - 120 }));
    expect(atmOf(long).type).toBe('CE');
    expect(atmOf(long).direction).toBe('LONG');
    expect(atmOf(short).type).toBe('PE');
    expect(atmOf(short).direction).toBe('SHORT');
    // v9.6: every candidate on the card list follows the lock
    for (const c of [...long, ...short]) expect(c.type).toBe(c.direction === 'LONG' ? 'CE' : 'PE');
  });

  it('premium ordering invariant: StopLoss < Entry (Buy) < Target — every card, every side, every basis', () => {
    const cases = [
      mkDeep('LONG', { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT - 40, target1: NIFTY_SPOT + 60 }),
      mkDeep('LONG', { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT - 200, target1: NIFTY_SPOT + 300 }),
      mkDeep('SHORT', { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT + 40, target1: NIFTY_SPOT - 60 }),
      mkDeep('SHORT', { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT + 250, target1: NIFTY_SPOT - 320 }),
      mkDeep('LONG', null), // no plan → premium-based fallback path
      mkDeep('SHORT', null),
    ];
    for (const deep of cases) {
      const cards = buildOptionSignalCards(desk, deep);
      expect(cards.length).toBeGreaterThanOrEqual(1);
      // v9.6: the invariant now holds on EVERY candidate (ATM/ITM/OTM)
      for (const { stopLoss, entry, target } of cards) {
        expect(stopLoss).toBeLessThan(entry);
        expect(entry).toBeLessThan(target);
        // max premium loss capped at 65% of entry
        expect(stopLoss).toBeGreaterThanOrEqual(entry * 0.35 - 0.06);
        // NSE 0.05 tick alignment
        for (const v of [stopLoss, entry, target]) {
          expect(Math.round(v * 20) / 20).toBeCloseTo(v, 10);
        }
      }
    }
  });

  it('translates the INDEX plan into premium terms (BS re-price at target1/stopLoss)', () => {
    const plan = { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT - 90, target1: NIFTY_SPOT + 120, target2: NIFTY_SPOT + 240 };
    const c = atmOf(buildOptionSignalCards(desk, mkDeep('LONG', plan)));
    expect(c.basis.target).toBe('index-plan→premium');
    expect(c.basis.stopLoss).toBe('index-plan→premium');
    expect(c.indexLevels.target1).toBeCloseTo(NIFTY_SPOT + 120, 1);
    expect(c.indexLevels.stopLoss).toBeCloseTo(NIFTY_SPOT - 90, 1);
    // target must meaningfully clear entry (≥ +10%)
    expect(c.target).toBeGreaterThan(c.entry * 1.09);
  });

  it('FLAT/NEUTRAL consensus produces NO directional card (honest)', () => {
    expect(buildOptionSignalCards(desk, mkDeep('FLAT', null))).toHaveLength(0);
    expect(buildOptionSignalCards(desk, { ok: false })).toHaveLength(0);
    expect(buildOptionSignalCards(desk, null)).toHaveLength(0);
    expect(buildOptionSignalCards({ ok: false }, mkDeep('LONG', null))).toHaveLength(0);
  });

  it('SENSEX desk: 100-step strikes, lot 20, Sensex display name', () => {
    const sExpiry = nextSensex(); // the real next SENSEX Thursday weekly
    const sdesk = mkDesk('SENSEX', 74489, sExpiry);
    const c = atmOf(buildOptionSignalCards(sdesk, mkDeep('SHORT', { entry: 74489, stopLoss: 74489 + 250, target1: 74489 - 300 })));
    expect(c.type).toBe('PE');
    expect(c.strike % 100).toBe(0);
    expect(c.lotSize).toBe(20);
    expect(c.name).toMatch(new RegExp(`^Sensex ${expiryLabel(sExpiry)} \\d+ PE$`));
    expect(STRIKE_STEPS.SENSEX).toBe(100);
    expect(LOT_SIZES.SENSEX).toBe(20);
  });
});

describe('v9.6 weekly expiry schedule — user-verified vs the live exchange', () => {
  // Reference clock: Fri 2026-09-11 14:00 IST (market open).
  const FRI_IST = new Date('2026-09-11T08:30:00Z');

  it('NIFTY weekly expiry is TUESDAY — Fri 11 Sep → 15 Sep (17Sep ka Nifty weekly exists hi nahi)', () => {
    // nextWeeklyExpiry(now, 2) — the NIFTY weekday under the corrected schedule
    const d = new Date(nextWeeklyExpiry(FRI_IST, 2));
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(8); // September (0-based)
    expect(d.getUTCDate()).toBe(15);
  });

  it('SENSEX weekly expiry is THURSDAY — Fri 11 Sep → 17 Sep', () => {
    const d = new Date(nextWeeklyExpiry(FRI_IST, 4));
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(8);
    expect(d.getUTCDate()).toBe(17);
  });

  it('expiryLabel renders DDMon shorthand for every month', () => {
    expect(expiryLabel('2026-09-17')).toBe('17Sep');
    // v20.0.1: day 2-digit PADDED — card-name contract (/^\d{2}Mon$/) ke saath
    // consistent (Oct 1-6 date-window me "6Oct" unpadded roza contract todta
    // tha; fixed-width terminal display norm bhi yahi hai).
    expect(expiryLabel('2026-01-05')).toBe('05Jan');
    expect(expiryLabel('2026-12-31')).toBe('31Dec');
    expect(expiryLabel('garbage')).toBeNull();
    expect(expiryLabel(null)).toBeNull();
  });

  it('synthetic SENSEX chain honours the given weekly expiry + 100 strikes', () => {
    const sExpiry = nextSensex();
    const chain = buildSyntheticChain('SENSEX', 74489, 0.13, sExpiry, 4);
    expect(chain.source).toBe('bs-model');
    expect(chain.atmStrike % 100).toBe(0);
    expect(chain.rows.length).toBeGreaterThan(5);
    for (const r of chain.rows) expect(r.expiry).toBe(sExpiry);
  });
});

describe('v9.6 superintelligence layer — AI score, POP, ranking, tradeable bar', () => {
  const EXPIRY = nextWeekly(); // the real next NIFTY Tuesday weekly (runtime)
  const NIFTY_SPOT = 23411;
  const desk = mkDesk('NIFTY', NIFTY_SPOT, EXPIRY);
  const atmOf = (cards) => cards.find(x => x.strikeBias === 'ATM') ?? cards[0];
  const PLAN = { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT - 90, target1: NIFTY_SPOT + 120, target2: NIFTY_SPOT + 240 };

  it('every card carries an AI score (0-100), a tier, a POP and a strike-bias chip', () => {
    const cards = buildOptionSignalCards(desk, mkDeep('LONG', PLAN));
    expect(cards.length).toBeGreaterThanOrEqual(1);
    for (const c of cards) {
      expect(c.aiScore).toBeGreaterThanOrEqual(0);
      expect(c.aiScore).toBeLessThanOrEqual(100);
      expect(['ELITE', 'STRONG', 'ACTION', 'WATCH']).toContain(c.tier);
      expect(c.pop).toBeGreaterThan(0);
      expect(c.pop).toBeLessThanOrEqual(100);
      expect(['ATM', 'ITM', 'OTM']).toContain(c.strikeBias);
      expect(c.machineNote).toBeTruthy();
      // long-CE breakeven = strike + premium paid
      expect(Math.abs(c.breakeven - (c.strike + c.entry))).toBeLessThanOrEqual(0.06);
      // exit plan rides with the card
      expect(c.exitPlan.t1).toBeGreaterThanOrEqual(c.entry);
      expect(c.exitPlan.t1).toBeLessThanOrEqual(c.target);
      expect(Math.abs(c.exitPlan.t2 - c.target)).toBeLessThanOrEqual(0.06);
      expect(Math.abs(c.exitPlan.hardStop - c.stopLoss)).toBeLessThanOrEqual(0.06);
    }
  });

  it('cards are ranked by AI score, best first (view merges → TOP 4)', () => {
    const cards = buildOptionSignalCards(desk, mkDeep('LONG', PLAN));
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i - 1].aiScore).toBeGreaterThanOrEqual(cards[i].aiScore);
    }
    // ITM/OTM candidates actually exist on the synthetic chain
    expect(new Set(cards.map(c => c.strikeBias)).size).toBeGreaterThanOrEqual(2);
  });

  it('tradeable mirrors the auto-agent bar: ACTION/STRONG grade YA 75+ AI score', () => {
    // (a) ACTION-grade consensus → tradeable (the standard desk case)
    expect(atmOf(buildOptionSignalCards(desk, mkDeep('LONG', PLAN))).tradeable).toBe(true);
    // (b) soft NEUTRAL consensus, low conf → score 75 ke neeche → WATCHLIST
    const weak = { ok: true, signal: { symbol: 'NIFTY', side: 'LONG', confidence: 40, grade: 'NEUTRAL', agreement: 0.5, plan: PLAN } };
    const c = atmOf(buildOptionSignalCards(desk, weak));
    expect(c.aiScore).toBeLessThan(75);
    expect(c.tradeable).toBe(false);
    expect(c.consensus.grade).toBe('NEUTRAL');
  });
});

// ============================================================
// v10.5.2 — DISTANCE-AWARE PUT-SKEW (ATM parity fix)
// ============================================================
describe('v10.5.2 distance-aware put-skew (ATM parity restored)', () => {
  // The v9.7 flat ATM bump (PE +0.8 / CE −0.3 vol pts at EVERY
  // strike — 1.1 vol pts combined) overpowered the r=6.9% carry on
  // near-dated ATM strikes and priced ATM puts ABOVE same-strike
  // calls (C−P ≈ −0.77 on a 1-day weekly — the reported bug). The
  // corrected model is distance-aware: skew ~0 AT the money (both
  // legs share ONE smile IV → the BS parity identity C−P = S−K·e^(−rT)
  // holds exactly) and the crash-insurance premium ramps in on OTM
  // puts (2–6% out — the same window computeSkewFlow() measures on
  // real chains). NOTE: the old "putIV − callIV ≥ 1 AT the money"
  // assertion was mathematically incompatible with C−P > 0 on a
  // ~1-day weekly (vega × 1.1 vol pts > the carry) — that very
  // contradiction IS the bug, so the demand-signal assertions moved
  // to the OTM wings where the premium actually lives.
  const SPOT = 23400; // exact 50-step multiple → the ATM row IS spot
  const R = 0.069;    // optionsDesk RISK_FREE (the carry driver)

  it('ATM is skew-neutral: PE IV = CE IV — and C−P keeps put-call parity (positive, ≈ carry)', () => {
    const expiry = istDateOut(2); // T ∈ (~1.6, ~2.6] days — a real near-dated weekly
    const chain = buildSyntheticChain('NIFTY', SPOT, 0.122, expiry, 6);
    const atm = chain.rows.find(r => r.strike === SPOT);
    // ATM legs share ONE smile IV → skew-neutral at the money.
    expect(atm.putIV).toBe(atm.callIV);
    // PARITY (the bug fix): C − P = S − K·e^(−rT) > 0 — calls trade
    // above puts by the carry, NEVER below (v9.7 flipped this −0.77).
    const T = yearsToExpiry(`${expiry}T15:30:00+05:30`);
    const carry = SPOT * (1 - Math.exp(-R * T));
    const gap = atm.callLTP - atm.putLTP;
    expect(gap).toBeGreaterThan(0);
    expect(Math.abs(gap - carry)).toBeLessThan(1.5); // pure carry, no skew drag
    // Crash premium is DISTANCE-AWARE now — it lives on the wings:
    const otmPut = chain.rows.find(r => r.strike === 23150);  // −1.07% OTM
    const otmCall = chain.rows.find(r => r.strike === 23650); // +1.07% OTM
    expect(otmPut.putIV).toBeGreaterThan(otmPut.callIV);  // same-strike: PE > CE
    expect(otmPut.putIV).toBeGreaterThan(otmCall.callIV); // mirror-strike: PE wing richer
  });

  it('skew survives the smile: wings pe bhi PE richer than CE at same distance', () => {
    const chain = buildSyntheticChain('NIFTY', 23400, 0.122, istDateOut(2), 6);
    const up = chain.rows.find(r => r.strike === 23500); // OTM for CE
    const dn = chain.rows.find(r => r.strike === 23300); // OTM for PE
    expect(dn.putIV).toBeGreaterThan(up.callIV);
  });

  it('SHORT cards still price PE entries off the (now skew-neutral) ATM put premium', () => {
    const spot = 23400, expiry = istDateOut(2);
    const plan = { entry: spot, stopLoss: spot + 90, target1: spot - 120, target2: spot - 240 };
    const cards = buildOptionSignalCards(mkDesk('NIFTY', spot, expiry), mkDeep('SHORT', plan));
    const pe = cards.find(c => c.type === 'PE' && c.strikeBias === 'ATM');
    expect(pe).toBeTruthy();
    // ATM straddle legs: PE entry must track the modelled ATM put leg
    // (the desk chain runs a slightly higher IV — 0.13 vs 0.122)
    const chain = buildSyntheticChain('NIFTY', spot, 0.122, expiry, 6);
    const atm = chain.rows.find(r => r.strike === 23400);
    expect(pe.entry).toBeGreaterThanOrEqual(atm.putLTP - 0.05);
  });
});

// ============================================================
// v10.5.2 ATM-parity REGRESSION — property-style, multi-combo
// ============================================================
describe('v10.5.2 ATM parity regression (property-style across spot/IV/expiry)', () => {
  // Locks the invariant the v9.7 flat skew broke: at EVERY combo of
  // spot, IV and time-to-expiry, the synthetic chain's ATM row must
  // satisfy C − P = S − K·e^(−rT) > 0 (calls above puts by the carry)
  // with skew-neutral IVs at the money. Spots are exact strike-step
  // multiples so the ATM row IS spot itself (BS identity exact).
  const R = 0.069;
  const combos: Array<[symbol: string, spot: number, iv: number, daysOut: number]> = [
    ['NIFTY', 23400, 0.10, 1],
    ['NIFTY', 22000, 0.15, 2],
    ['NIFTY', 24550, 0.22, 5],
    ['BANKNIFTY', 48000, 0.18, 2],
    ['BANKNIFTY', 52000, 0.30, 9],
    ['NIFTY', 23400, 0.28, 30],
  ];
  it.each(combos)('%s spot=%d iv=%s +%sd: ATM putIV=callIV and C−P = carry > 0', (symbol, spot, iv, daysOut) => {
    const expiry = istDateOut(daysOut);
    const chain = buildSyntheticChain(symbol, spot, iv, expiry, 8);
    expect(chain).toBeTruthy();
    const atm = chain.rows.find(r => r.strike === spot);
    expect(atm).toBeTruthy();
    // skew-neutral at the money (the distance-aware ramp starts at 0)
    expect(atm.putIV).toBe(atm.callIV);
    // parity: gap = pure carry — positive, within rounding of theory
    const T = yearsToExpiry(`${expiry}T15:30:00+05:30`);
    const carry = spot * (1 - Math.exp(-R * T));
    const gap = atm.callLTP - atm.putLTP;
    expect(gap).toBeGreaterThan(0);                   // parity direction (the bug)
    expect(Math.abs(gap - carry)).toBeLessThan(1.5);  // and its magnitude ≈ theory
  });
});

describe('v9.7 MONTHLY-ONLY expiries (SEBI weekly rationalization)', () => {
  // Saturday 12 Sep 2026, 19:00 IST → IST date = 2026-09-12
  const NOW = new Date('2026-09-12T13:30:00Z');

  it('NIFTY weekly stays next TUESDAY (15Sep)', () => {
    expect(nextWeeklyExpiryFor('NIFTY', NOW)).toBe('2026-09-15'); // Tuesday
  });

  it('SENSEX weekly stays next THURSDAY (17Sep)', () => {
    expect(nextWeeklyExpiryFor('SENSEX', NOW)).toBe('2026-09-17'); // Thursday
  });

  it('BANKNIFTY is monthly-only → LAST TUESDAY of Sep 2026 (29Sep), not next Tuesday', () => {
    const d = nextWeeklyExpiryFor('BANKNIFTY', NOW);
    expect(d).toBe('2026-09-29'); // 29 Sep 2026 is the last Tuesday
    expect(new Date(`${d}T00:00:00Z`).getUTCDay()).toBe(2);
  });

  it('FINNIFTY/MIDCPNIFTY/NIFTYNXT50 follow the same last-Tuesday rule', () => {
    for (const sym of ['FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']) {
      const d = nextWeeklyExpiryFor(sym, NOW);
      expect(new Date(`${d}T00:00:00Z`).getUTCDay()).toBe(2);
      expect(d).toBe('2026-09-29');
    }
  });

  it('after the last Tuesday 15:30 IST → rolls to NEXT month last Tuesday', () => {
    // 29 Sep 2026 16:00 IST (expiry passed) → Oct 2026 ka last Tuesday = 27Oct
    const after = new Date('2026-09-29T10:30:00Z'); // 16:00 IST
    expect(nextWeeklyExpiryFor('BANKNIFTY', after)).toBe('2026-10-27');
  });
});

// ============================================================
// v10.11 EXPIRY-DAY FIX — the regression that actually fired live:
// on the expiry-day MORNING (2026-09-15, the real NIFTY Tuesday
// weekly, ~15:20 IST) the OTM candidate's premium had collapsed to
// the ₹0.05 tick and the card served a degenerate 0.05/0.05/0.05
// ticket (SL == entry == target) — "wrong call" numbers next to a
// fresh-looking consensus.
//
// THE CONTRACT (locked here):
//   • sub-₹1 collapsed-premium rows are DROPPED from the candidate
//     list (below ~₹1 the bid-ask spread IS the premium — no honest
//     card exists for that strike).
//   • every surviving card keeps StopLoss < Entry < Target — on ANY
//     runtime clock, including minutes-to-expiry.
// ============================================================
describe('v10.11 expiry-day fix — collapsed premiums never serve degenerate cards', () => {
  it('a sub-₹1 collapsed OTM row is DROPPED from the candidate list (honest skip)', () => {
    const desk = {
      ok: true, symbol: 'NIFTY', spot: 23411, expiry: istDateOut(4), dte: 4,
      lotSize: LOT_SIZES['NIFTY'] || 1, source: 'bs-model', syntheticNote: 'model chain',
      rows: [
        { strike: 23400, callLTP: 120.4, putLTP: 98.2, callIV: 13, putIV: 13 },   // ATM
        { strike: 23350, callLTP: 145.6, putLTP: 75.1, callIV: 13, putIV: 13 },   // ITM (CE)
        { strike: 23450, callLTP: 0.04, putLTP: 210.0, callIV: 13, putIV: 13 },   // collapsed OTM
      ],
    };
    const cards = buildOptionSignalCards(desk, mkDeep('LONG', null));
    expect(cards.map(c => c.strike)).not.toContain(23450); // dropped — no honest card
    expect(cards.length).toBe(2);                           // ATM + ITM still serve
    for (const c of cards) {
      expect(c.entry).toBeGreaterThanOrEqual(1.0);          // tradeable floor holds
      expect(c.stopLoss).toBeLessThan(c.entry);             // never degenerate
      expect(c.entry).toBeLessThan(c.target);
    }
  });

  it('expiry-morning runtime clock (the REAL next weekly, however near) → invariant holds on every card', () => {
    // On expiry-day mornings nextWeekly() is only hours/minutes away — the
    // exact window that fired the bug. The invariant must hold regardless.
    const SPOT = 23411;
    const desk = {
      ok: true, symbol: 'NIFTY', spot: SPOT, expiry: nextWeekly(), dte: 4,
      lotSize: LOT_SIZES['NIFTY'] || 1, source: 'bs-model', syntheticNote: 'model chain',
      rows: buildSyntheticChain('NIFTY', SPOT, 0.13, nextWeekly(), 8)?.rows || [],
    };
    const cases = [
      mkDeep('LONG', { entry: SPOT, stopLoss: SPOT - 40, target1: SPOT + 60 }),
      mkDeep('LONG', null),
      mkDeep('SHORT', null),
    ];
    for (const deep of cases) {
      const cards = buildOptionSignalCards(desk, deep);
      expect(cards.length).toBeGreaterThanOrEqual(1); // ATM/ITM survive the floor
      for (const c of cards) {
        expect(c.entry).toBeGreaterThanOrEqual(1.0);
        expect(c.stopLoss).toBeLessThan(c.entry);
        expect(c.entry).toBeLessThan(c.target);
      }
    }
  });
});
