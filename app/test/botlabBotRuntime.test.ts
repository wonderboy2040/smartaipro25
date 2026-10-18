// ============================================================
// test/botlabBotRuntime.test.ts — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Strategy spec locks (plan §6) + hard-risk layer (plan §11) +
// state contract (plan §10.3) + virtual accounts (plan §9):
//   ORB-IN  : confirmation (prev inside, this outside), gap-through,
//             range-band filter, last-entry cutoff, one-attempt/day
//   ORB-CRYPTO : UTC session one-and-done, exact geometry
//   LVL     : sweep + reclaim geometry (entry/stop/target R math),
//             short mirror, no-reclaim rejection, one-per-session
//   botRisk : daily loss, kill switch, caps, stale feed, fee gate,
//             cooldown, trade cap — and the PAPER default
//   botState: atomic save, events append, STOP files
//   accounts: gross/net split, day rollover
//   deciders: 3 arms share candidates; stable veto reasons
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import orbIn from '../server/bots/strategies/orbIn.js';
import { makeOrbCrypto } from '../server/bots/strategies/orbCrypto.js';
import { makeLvl } from '../server/bots/strategies/lvl.js';
import { makeEnsembleAdapter } from '../server/bots/strategies/ensembleAdapter.js';
import { botRiskCheck, botRiskConfig, expectedGross, sizePosition, BOT_RISK_DEFAULTS } from '../server/bots/botRisk.js';
import { saveBotState, loadBotState, appendEvent, readEvents, setKillSwitch, killSwitchActive, activeKillSwitches, globalPauseActive } from '../server/bots/botState.js';
import { blankAccount, applyTrade, loadAccount, accountStats, saveAccount } from '../server/bots/accounts.js';
import { makeDecider } from '../server/bots/deciders.js';

// ---------------- bar builders ----------------
/** IST bar on day `d` at IST minute `m` (09:15 = 555). */
function istBar(d, m, o, c, v = 1000, wick = 0.3) {
  const day0 = Date.UTC(2026, 8, 6 + d); // Sept 6 2026 (calendar irrelevant, synthetic)
  return {
    time: day0 + (m - 330) * 60000, // IST = UTC+5:30
    open: o, close: c,
    high: Math.max(o, c) + wick,
    low: Math.min(o, c) - wick,
    volume: v,
  };
}
function utcBar(d, m, o, c, v = 1000, wick = 0.3, hi = null, lo = null) {
  const day0 = Date.UTC(2026, 8, 6 + d);
  return {
    time: day0 + m * 60000,
    open: o, close: c,
    high: hi != null ? hi : Math.max(o, c) + wick,
    low: lo != null ? lo : Math.min(o, c) - wick,
    volume: v,
  };
}

/** 4 flat warmup NSE days + a signal day spec. */
function nseBars(signalDay: (m: number, idx: number) => { o: number; c: number; v?: number; hi?: number; lo?: number } | null) {
  const bars = [];
  for (let d = 0; d < 4; d++) {
    for (let b = 0; b < 75; b++) {
      const m = 555 + b * 5;
      bars.push(istBar(d, m, 100 + (b % 3) * 0.05, 100 + ((b + 1) % 3) * 0.05));
    }
  }
  for (let b = 0; b < 75; b++) {
    const m = 555 + b * 5;
    const s = signalDay(m, b);
    if (!s) break;
    bars.push(istBar(4, m, s.o, s.c, s.v ?? 1000, 0.3));
    // apply explicit hi/lo after creation when the spec asks (gap-through etc.)
    if (s.hi != null || s.lo != null) {
      const bar = bars[bars.length - 1];
      if (s.hi != null) bar.high = s.hi;
      if (s.lo != null) bar.low = s.lo;
      bar.high = Math.max(bar.high, bar.open, bar.close);
      bar.low = Math.min(bar.low, bar.open, bar.close);
    }
  }
  return bars;
}

describe('v20.8 ORB-IN — plan §6.1 spec locks', () => {
  it('confirmation: prev close inside, this close outside -> LONG, stop at range low, 2R target', () => {
    const bars = nseBars((m) => {
      if (m < 570) return { o: 100.2, c: 100.4 };            // range window 09:15-09:25 -> [~99.7, 100.7]
      if (m === 570) return { o: 100.5, c: 100.6 };          // 09:30 inside
      if (m === 575) return { o: 100.8, c: 103, v: 1400 };   // 09:35 breakout close
      return null;
    });
    const rows = orbIn.prepare(bars, { atrPeriodBars: 20 });
    const iSig = rows.findIndex(r => r.bar.close === 103);
    expect(iSig).toBeGreaterThan(0);
    const cand = orbIn.detect(rows, iSig, { symbol: 'NIFTY', state: {} });
    expect(cand).not.toBeNull();
    expect(cand!.side).toBe('LONG');
    expect(cand!.stop).toBeCloseTo(99.9, 1);      // range low (wick-adjusted: 100.2 − 0.3)
    const stopDist = 103 - cand!.stop;
    expect(cand!.target).toBeCloseTo(103 + 2 * stopDist, 1);
    expect(cand!.features.or_size_atr).toBeGreaterThan(0.4);
    expect(cand!.features.vol_ratio_tod).toBeCloseTo(1.4, 1);
    expect(cand!.audit.confirmOutside).toBe(true);
  });

  it('gap-through day is caught (prev close inside, gap open above, close above)', () => {
    const bars = nseBars((m) => {
      if (m < 570) return { o: 100.2, c: 100.4 };
      if (m === 570) return { o: 100.5, c: 100.6 };
      if (m === 575) return { o: 104, c: 104.5, v: 1500 };   // gap through
      return null;
    });
    const rows = orbIn.prepare(bars, { atrPeriodBars: 20 });
    const iSig = rows.findIndex(r => r.bar.close === 104.5);
    const cand = orbIn.detect(rows, iSig, { symbol: 'NIFTY', state: {} });
    expect(cand).not.toBeNull();
    expect(cand!.side).toBe('LONG');
  });

  it('one attempt per day: second breakout same day -> null', () => {
    const bars = nseBars((m) => {
      if (m < 570) return { o: 100.2, c: 100.4 };
      if (m === 570) return { o: 100.5, c: 100.6 };
      if (m === 575) return { o: 100.8, c: 103, v: 1400 };
      if (m === 580) return { o: 103.5, c: 106, v: 1600 };   // second breakout
      return null;
    });
    const rows = orbIn.prepare(bars, { atrPeriodBars: 20 });
    const i1 = rows.findIndex(r => r.bar.close === 103);
    const i2 = rows.findIndex(r => r.bar.close === 106);
    expect(orbIn.detect(rows, i1, { symbol: 'NIFTY', state: {} })).not.toBeNull();
    expect(orbIn.detect(rows, i2, { symbol: 'NIFTY', state: {} })).toBeNull();
  });

  it('range out of ATR band (0.5-2.0) -> no trade that day (attempt burned)', () => {
    const bars = nseBars((m) => {
      if (m < 570) return { o: 95 + (m % 10), c: 99 - (m % 7) }; // giant range >> 2 ATR
      if (m === 570) return { o: 98, c: 98.5 };
      if (m === 575) return { o: 99, c: 108, v: 1400 };
      return null;
    });
    const rows = orbIn.prepare(bars, { atrPeriodBars: 20 });
    const iSig = rows.findIndex(r => r.bar.close === 108);
    const cand = orbIn.detect(rows, iSig, { symbol: 'NIFTY', state: {} });
    expect(cand).toBeNull(); // range ~[94.7, 100.4+] size >> 2*ATR
  });

  it('last-entry cutoff 11:30 IST: breakout at 11:35 -> null', () => {
    const bars = nseBars((m) => {
      if (m < 570) return { o: 100.2, c: 100.4 };
      if (m < 695) return { o: 100.3, c: 100.4 };            // quiet morning
      if (m === 695) return { o: 100.5, c: 100.6 };          // 11:30 inside
      if (m === 700) return { o: 100.8, c: 103, v: 1400 };   // 11:35 breakout (too late)
      return null;
    });
    const rows = orbIn.prepare(bars, { atrPeriodBars: 20 });
    const iSig = rows.findIndex(r => r.bar.close === 103);
    expect(orbIn.detect(rows, iSig, { symbol: 'NIFTY', state: {} })).toBeNull();
  });

  it('prev bar already closed outside -> no fresh crossing -> null', () => {
    const bars = nseBars((m) => {
      if (m < 570) return { o: 100.2, c: 100.4 };
      if (m === 570) return { o: 101, c: 103, v: 1400 };     // 09:30 itself broke out
      if (m === 575) return { o: 103.5, c: 104 };            // 09:35 also outside
      return null;
    });
    const rows = orbIn.prepare(bars, { atrPeriodBars: 20 });
    const iSig = rows.findIndex(r => r.bar.close === 104);
    expect(orbIn.detect(rows, iSig, { symbol: 'NIFTY', state: {} })).toBeNull();
  });
});

describe('v20.8 ORB-CRYPTO — session variants (plan §6.2)', () => {
  const strat = makeOrbCrypto({ session: 'utc', rangeMinutes: 30, atrPeriodBars: 20 });
  function cryptoBars() {
    const bars = [];
    for (let d = 0; d < 3; d++) for (let b = 0; b < 96; b++) {
      bars.push(utcBar(d, b * 5, 100 + (b % 2) * 0.2, 100 + ((b + 1) % 2) * 0.2, 1000, 0.3));
    }
    // day 3: range 00:00-00:25 = [99.7, 100.7]; 00:30 inside; 00:35 breakout
    for (let b = 0; b < 8; b++) {
      const m = b * 5;
      if (m < 30) bars.push(utcBar(3, m, 100.1, 100.3, 1000, 0.3));
      else if (m === 30) bars.push(utcBar(3, m, 100.3, 100.4, 1000, 0.2));
      else if (m === 35) bars.push(utcBar(3, m, 100.8, 103, 1400, 0.3));
      else bars.push(utcBar(3, m, 103, 103.5, 1200, 0.3));
    }
    return bars;
  }
  it('UTC-session breakout: exact geometry + volume feature', () => {
    const bars = cryptoBars();
    const rows = strat.prepare(bars);
    const iSig = rows.findIndex(r => r.bar.close === 103);
    expect(iSig).toBeGreaterThan(0);
    const cand = strat.detect(rows, iSig, { symbol: 'BTC', state: {} });
    expect(cand).not.toBeNull();
    expect(cand!.side).toBe('LONG');
    expect(cand!.stop).toBeLessThan(100.7);            // opposite range edge (wick low)
    expect(cand!.target).toBeCloseTo(103 + 2 * (103 - cand!.stop), 1);
    expect(cand!.features.vol_ratio_tod).toBeCloseTo(1.4, 1);
    expect(cand!.features.session_variant).toBe('utc');
  });
  it('one-and-done per session: second breakout same session -> null', () => {
    const bars = cryptoBars();
    const rows = strat.prepare(bars);
    const i1 = rows.findIndex(r => r.bar.close === 103);
    const i2 = rows.findIndex(r => r.bar.close === 103.5);
    expect(strat.detect(rows, i1, { symbol: 'BTC', state: {} })).not.toBeNull();
    expect(strat.detect(rows, i2, { symbol: 'BTC', state: {} })).toBeNull();
  });
  it('london/ny variants carry their own session offsets', () => {
    const lon = makeOrbCrypto({ session: 'london', rangeMinutes: 30, atrPeriodBars: 20 });
    expect(lon.id).toBe('orb_crypto_london');
    expect(lon.sessionVariant).toBe('london');
    const ny = makeOrbCrypto({ session: 'ny' });
    expect(ny.id).toBe('orb_crypto_ny');
  });
});

describe('v20.8 LVL — liquidity sweep geometry (plan §6.3)', () => {
  const strat = makeLvl({ desk: 'crypto', atrPeriodBarsCrypto: 20 });
  function lvlBars(day2Spec: { hi?: number; lo?: number; c: number }[] ) {
    const bars = [];
    // day 0: session range [100, 110] via spike bars, otherwise ~105
    for (let b = 0; b < 30; b++) {
      const o = 105, c = 105 + (b % 2 ? 0.3 : -0.3);
      bars.push(utcBar(0, b * 5, o, c, 1000, 0.3, b === 5 ? 110 : undefined, b === 6 ? 100 : undefined));
    }
    // day 1: the sweep day
    day2Spec.forEach((s, b) => {
      bars.push(utcBar(1, b * 5, 105, s.c, 1200, 0.3, s.hi, s.lo));
    });
    return bars;
  }
  it('long sweep: entry L+0.25R, stop L+0.125R, target L+0.50R', () => {
    const bars = lvlBars([{ lo: 99, c: 104 }, { c: 104.5 }]);
    const rows = strat.prepare(bars);
    const iSig = rows.findIndex(r => r.bar.close === 104);
    expect(iSig).toBeGreaterThan(0);
    const cand = strat.detect(rows, iSig, { symbol: 'BTC', state: {} });
    expect(cand).not.toBeNull();
    expect(cand!.side).toBe('LONG');
    expect(cand!.entry).toBeCloseTo(102.5, 3);   // 100 + 0.25*10
    expect(cand!.stop).toBeCloseTo(101.25, 3);   // 100 + 0.125*10
    expect(cand!.target).toBeCloseTo(105, 3);    // 100 + 0.50*10
    expect(cand!.features.sweep_atr).toBeGreaterThan(0.15);
    expect(cand!.audit.closeBackInside).toBe(true);
    expect(cand!.frictionRiskR).toBeGreaterThan(0); // tight-stop friction surfaced
  });
  it('short mirror: entry H-0.25R, stop H-0.125R, target H-0.50R', () => {
    const bars = lvlBars([{ hi: 111, c: 106 }, { c: 105.5 }]);
    const rows = strat.prepare(bars);
    const iSig = rows.findIndex(r => r.bar.close === 106);
    const cand = strat.detect(rows, iSig, { symbol: 'BTC', state: {} });
    expect(cand).not.toBeNull();
    expect(cand!.side).toBe('SHORT');
    expect(cand!.entry).toBeCloseTo(107.5, 3);
    expect(cand!.stop).toBeCloseTo(108.75, 3);
    expect(cand!.target).toBeCloseTo(105, 3);
  });
  it('sweep WITHOUT reclaim (closed outside) -> null, and does NOT burn the session', () => {
    const bars = lvlBars([{ lo: 99, c: 99.5 }, { lo: 99.2, c: 104.5 }]); // first closes outside
    const rows = strat.prepare(bars);
    const i0 = rows.findIndex(r => r.bar.close === 99.5);
    expect(strat.detect(rows, i0, { symbol: 'BTC', state: {} })).toBeNull();
    // the NEXT bar sweeps AND reclaims -> candidate still allowed (v20.8.0 fix)
    const i1 = rows.findIndex(r => r.bar.close === 104.5);
    const cand = strat.detect(rows, i1, { symbol: 'BTC', state: {} });
    expect(cand).not.toBeNull();
    expect(cand!.side).toBe('LONG');
  });
  it('one per session: second sweep-reclaim same session -> null', () => {
    const bars = lvlBars([{ lo: 99, c: 104 }, { lo: 98.9, c: 104.2 }]);
    const rows = strat.prepare(bars);
    const i0 = rows.findIndex(r => r.bar.close === 104);
    const i1 = rows.findIndex(r => r.bar.close === 104.2);
    expect(strat.detect(rows, i0, { symbol: 'BTC', state: {} })).not.toBeNull();
    expect(strat.detect(rows, i1, { symbol: 'BTC', state: {} })).toBeNull();
  });
});

describe('v20.8 ENSEMBLE-ADAPTER (plan §6.5)', () => {
  it('aligns a recorded STRONG signal onto its bar and builds ATR stop/2R target', () => {
    const bars = [];
    for (let d = 0; d < 3; d++) for (let b = 0; b < 96; b++) {
      bars.push(utcBar(d, b * 5, 100, 100 + (b % 2) * 0.2, 1000, 0.3));
    }
    // signal INSIDE the last bar (ts between bar.time and bar.time+5min)
    const lastBarTime = bars[bars.length - 1].time;
    const log = [{ ts: lastBarTime + 60000, symbol: 'BTC', market: 'CRYPTO', side: 'LONG', confidence: 82, agreement: 0.75, grade: 'STRONG' }];
    const strat = makeEnsembleAdapter(log, { atrPeriodBarsCrypto: 20 });
    const rows = strat.prepare(bars, { market: 'CRYPTO' });
    const cand = strat.detect(rows, rows.length - 1, { symbol: 'BTC', market: 'CRYPTO', state: {} });
    expect(cand).not.toBeNull();
    expect(cand!.side).toBe('LONG');
    expect(cand!.features.ensemble_confidence).toBe(82);
    expect(cand!.features.ensemble_agreement).toBe(0.75);
    // stop = prior close - 1.5 ATR
    const priorClose = bars[bars.length - 2].close;
    expect(cand!.stop).toBeLessThan(priorClose);
  });
  it('below-STRONG confidence signals are not candidates', () => {
    const bars = [];
    for (let d = 0; d < 2; d++) for (let b = 0; b < 60; b++) bars.push(utcBar(d, b * 5, 100, 100, 1000, 0.3));
    const t = bars[bars.length - 1].time + 60000;
    const strat = makeEnsembleAdapter([{ ts: t, symbol: 'BTC', market: 'CRYPTO', side: 'LONG', confidence: 60, agreement: 0.5, grade: 'MODERATE' }]);
    const rows = strat.prepare(bars);
    expect(strat.detect(rows, rows.length - 1, { symbol: 'BTC', market: 'CRYPTO', state: {} })).toBeNull();
  });
});

describe('v20.8 botRisk — hard rules, AI ke upar (plan §11)', () => {
  it('PAPER is the default mode; LIVE needs explicit env', () => {
    expect(BOT_RISK_DEFAULTS.mode).toBe('PAPER');
    expect(botRiskConfig({}).mode).toBe('PAPER');
    expect(botRiskConfig({ BOTS_MODE: 'LIVE' }).mode).toBe('LIVE');
  });
  it('per-bot daily loss kills trading', () => {
    // v20.8.1: REAL account shape — todayPnl is {gross, net} (accounts.js).
    // The old test passed a bare number, masking the production bug where
    // Number({}) = NaN killed the rule.
    const r = botRiskCheck({
      cfg: BOT_RISK_DEFAULTS, bot: 'orb_in',
      account: { startingEquity: 500000, equity: 480000, todayPnl: { gross: -16000, net: -15000 }, tradesToday: 0 },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('bot_daily_loss');
  });
  it('v20.8.1: uncomputable round-trip cost fails the fee gate CLOSED', () => {
    const r = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'x', account: {}, feeGate: { expectedGross: 50, roundTripCost: null } });
    expect(r.reasons).toContain('fee_gate:cost_uncomputable');
  });
  it('kill switch blocks everything', () => {
    const r = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'x', killSwitches: { active: ['x'] }, account: {} });
    expect(r.reasons).toContain('kill_switch');
  });
  it('open-position caps per bot and total', () => {
    const r = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'a', openCounts: { perBot: { a: 1 }, total: 1 }, account: {} });
    expect(r.reasons.some(x => x.startsWith('max_open_per_bot'))).toBe(true);
    const r2 = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'b', openCounts: { perBot: { b: 0 }, total: 3 }, account: {} });
    expect(r2.reasons.some(x => x.startsWith('max_open_total'))).toBe(true);
  });
  it('stale feed = no trade', () => {
    const r = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'x', feedAgeSec: 120, account: {} });
    expect(r.reasons.some(x => x.startsWith('stale_feed'))).toBe(true);
  });
  it('fee gate: edge must clear 1.5x round-trip cost (pWin from BACKTEST, not Jev)', () => {
    const eg = expectedGross({ pWin: 0.5, rewardMoney: 200, riskMoney: 100 });
    expect(eg).toBeCloseTo(50);
    const blocked = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'x', account: {}, feeGate: { expectedGross: 5, roundTripCost: 4 } });
    expect(blocked.reasons.some(x => x.startsWith('fee_gate'))).toBe(true);
    const ok = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'x', account: {}, feeGate: { expectedGross: 50, roundTripCost: 4 } });
    expect(ok.reasons.some(x => x.startsWith('fee_gate'))).toBe(false);
  });
  it('re-entry cooldown + trades/day cap', () => {
    const r = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'x', account: { tradesToday: 4 }, now: 1000000, openCounts: {} });
    expect(r.reasons.some(x => x.startsWith('max_trades_per_day'))).toBe(true);
    const r2 = botRiskCheck({ cfg: BOT_RISK_DEFAULTS, bot: 'x', account: { lastTradeTs: 990000 }, now: 1000000, openCounts: {} });
    expect(r2.reasons.some(x => x.startsWith('reentry_cooldown'))).toBe(true);
  });
  it('sizePosition: risk-based qty + leverage cap + visible risk shrink', () => {
    const s = sizePosition({ equity: 10000, riskPerTradePct: 0.5, stopDistance: 10, price: 100, leverage: 3, maxLeverage: 3 });
    expect(s!.qty).toBeCloseTo(5, 3);
    expect(s!.achievedRiskPct).toBeCloseTo(0.5, 4);
    expect(s!.riskShrunkByCap).toBe(false);
    // huge notional -> leverage cap shrinks size and REPORTS the shrink
    const s2 = sizePosition({ equity: 10000, riskPerTradePct: 0.5, stopDistance: 10, price: 7000, leverage: 3, maxLeverage: 3 });
    expect(s2!.riskShrunkByCap).toBe(true);
    expect(s2!.achievedRiskPct).toBeLessThan(0.5);
    expect(s2!.qty * 7000).toBeLessThanOrEqual(10000 * 3 + 1e-6);
  });
  it('v20.8.1: 1-unit floor that would INFLATE risk past the ceiling is refused (engine parity)', () => {
    // tight stop: risk qty = 0.5 -> floored to 1 unit risks 20% — over the ceiling
    const s = sizePosition({ equity: 100, riskPerTradePct: 0.5, stopDistance: 20, price: 100, qtyUnitMin: 1, qtyUnitMax: 3 });
    expect(s && typeof s === 'object' && 'skip' in s ? s.skip : null).toBe('sizing_over_risk');
    // sane floor: risk qty 0.83 -> floored to 1 unit risks 60 (1.2x budget,
    // within the 3x ceiling) -> allowed, inflation flagged
    const s2 = sizePosition({ equity: 10000, riskPerTradePct: 0.5, stopDistance: 60, price: 100, qtyUnitMin: 1 });
    expect(s2!.qty).toBe(1);
    expect(s2!.riskInflatedByMinUnit).toBe(true);
  });
});

describe('v20.8 botState — atomic state + kill switches (plan §10.3)', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botstate-')); });
  it('save/load roundtrip; bot field enforced', () => {
    saveBotState(dir, 'orb_in', { arm: 'jev', account: { equity: 1 } });
    const st = loadBotState(dir, 'orb_in');
    expect(st!.arm).toBe('jev');
    expect(st!.bot).toBe('orb_in');
    expect(() => saveBotState(dir, '', {})).toThrow();
  });
  it('events append-only + bounded read', () => {
    appendEvent(dir, 'orb_in', { kind: 'decision', action: 'wait', reason: 'low_volume' });
    // v20.8.2 FIX: real production order events carry {kind:'order', ok}
    // with NO action field — the old fabricated {kind:'order', action:'take'}
    // shape locked a contract production never emits (masked the dead
    // ORDERED rendering in BotsTab).
    appendEvent(dir, 'orb_in', { kind: 'order', symbol: 'NIFTY', ok: true });
    const evs = readEvents(dir, 'orb_in', 10);
    expect(evs).toHaveLength(2);
    expect(evs[0].kind).toBe('decision');
    expect(evs[1].bot).toBe('orb_in');
    expect(evs[1].ok).toBe(true);
    expect(evs[1].action).toBeUndefined();
    expect(evs[1].at).toBeTruthy();
  });
  it('kill switch: STOP file presence toggles', () => {
    expect(killSwitchActive(dir, 'lvl')).toBe(false);
    setKillSwitch(dir, 'lvl', true, 'test');
    expect(killSwitchActive(dir, 'lvl')).toBe(true);
    expect(activeKillSwitches(dir)).toContain('lvl');
    setKillSwitch(dir, 'lvl', false);
    expect(killSwitchActive(dir, 'lvl')).toBe(false);
  });
  it('global pause file blocks all bots', () => {
    fs.writeFileSync(path.join(dir, 'STOP_ALL'), '{}');
    expect(globalPauseActive(dir)).toBe(true);
  });
});

describe('v20.8 accounts — bot-wise virtual books (plan §9)', () => {
  it('blankAccount: INR for india bots, USDT for crypto', () => {
    expect(blankAccount('orb_in').currency).toBe('INR');
    expect(blankAccount('lvl').currency).toBe('USDT');
    expect(blankAccount('orb_in').startingEquity).toBe(500000);
  });
  it('applyTrade: gross/net split, fees, R stats, drawdown tracking', () => {
    let acc = blankAccount('lvl');
    acc = applyTrade(acc, { grossPnl: 100, netPnl: 90, fees: 10, rNet: 0.9 });
    expect(acc.equity).toBeCloseTo(10090);
    expect(acc.todayPnl.gross).toBeCloseTo(100);
    expect(acc.todayPnl.net).toBeCloseTo(90);
    expect(acc.feesPaid).toBeCloseTo(10);
    expect(acc.wins).toBe(1);
    expect(acc.rSum).toBeCloseTo(0.9);
    acc = applyTrade(acc, { grossPnl: -50, netPnl: -60, fees: 10, rNet: -0.6 });
    expect(acc.losses).toBe(1);
    expect(acc.maxDrawdownPct).toBeGreaterThan(0);
    const s = accountStats(acc);
    expect(s.winRate).toBeCloseTo(0.5);
    expect(s.avgR).toBeCloseTo(0.15);
  });
  it('day rollover resets today counters', () => {
    let acc = blankAccount('lvl');
    acc = applyTrade(acc, { grossPnl: 10, netPnl: 9, fees: 1, rNet: 0.9 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
    saveAccount(dir, acc);
    const loaded = loadAccount(dir, 'lvl', { dayKey: '2099-01-01' });
    expect(loaded.todayPnl.net).toBe(0);
    expect(loaded.tradesToday).toBe(0);
    expect(loaded.equity).toBeCloseTo(10009); // lifetime equity persists
  });
});

describe('v20.8 deciders — 3 arms, same candidates (plan §7.1)', () => {
  const goodRow = { atr: 1, emaFastSlope: 0.05 };
  const goodCand = {
    symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100,
    features: { vol_ratio_tod: 1.4, trend_align: 1, room_to_target_atr: 2.5, dist_pdh_atr: 3, dist_pdl_atr: 3, ema_fast_slope_atr: 0.05 },
  };
  it('rules arm takes everything', async () => {
    const d = makeDecider({ arm: 'rules', strategy: orbIn });
    expect((await d(goodCand, goodRow)).action).toBe('take');
  });
  it('gated arm: stable veto reasons, first veto wins', async () => {
    const d = makeDecider({ arm: 'gated', strategy: orbIn });
    expect((await d(goodCand, goodRow)).action).toBe('take');
    const lowVol = { ...goodCand, features: { ...goodCand.features, vol_ratio_tod: 0.5 } };
    const v = await d(lowVol, goodRow);
    expect(v.action).toBe('wait');
    expect(v.reason).toBe('low_volume');
    const against = { ...goodCand, features: { ...goodCand.features, trend_align: -1 } };
    expect((await d(against, goodRow)).reason).toBe('against_trend');
  });
  it('jev arm: verdict carries jev telemetry; arm identity preserved', async () => {
    const jev = async () => ({ action: 'enter_long', probs: { enter_long: 0.6 }, cached: true, latencyMs: 42 });
    const d = makeDecider({ arm: 'jev', strategy: orbIn, jev });
    const v = await d(goodCand, goodRow);
    // v20.8.1 FIX LOCK: the decider contract is 'take'|'wait' — the Jev
    // client's raw choice rides on jev.choice. The old pass-through made
    // every Jev approval a veto in BOTH consumers (the arm was a placebo).
    expect(v.action).toBe('take');
    expect(v.arm).toBe('jev');
    expect(v.jev.choice).toBe('enter_long');
    expect(v.jev.cached).toBe(true);
    const jevWait = async () => ({ action: 'wait', probs: { wait: 0.9 }, cached: false, latencyMs: 5 });
    const d2 = makeDecider({ arm: 'jev', strategy: orbIn, jev: jevWait });
    expect((await d2(goodCand, goodRow)).action).toBe('wait');
  });
  it('unknown arm throws honestly', () => {
    expect(() => makeDecider({ arm: 'psychic', strategy: orbIn })).toThrow();
  });
});
