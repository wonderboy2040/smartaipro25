// ============================================================
// test/signalTrust.test.ts — v12.4 SIGNAL CONTINUITY ENGINE
// ------------------------------------------------------------
// LOCKED HERE (the WLD incident class):
//   • CONTINUITY — firstSeenAt age tracking across observations,
//     FLIP detection with prevSide + bounded 24h history, FLAT
//     handling (side cleared, last directional view preserved)
//   • OB/OS HARD GUARD — RSI ≥ 70 LONG / RSI ≤ 30 SHORT can never
//     wear ACTION/STRONG (WATCH cap + confidence floor); extreme
//     bands cut harder; neutral RSI untouched; grade never UPGRADED
//   • FLIP COOLDOWN — a side younger than 5m since the flip is
//     capped to WATCH; 5-10m takes a soft haircut; older flips pass
//   • WIRE — buildSignal forwards signalAge / obOs / freshFlip
//   • PERSISTENCE — holdingPositions reads journal + manual stores
//     (market filter, SELL→SHORT, pair normalization), and
//     pinHoldingOnBoard stamps existing cards + pins missing ones
//     (bounded), buildHoldingCard stays honest (≤WATCH, no plan,
//     not executable, holdingOnly marker)
// Hermetic: in-memory store mock (same pattern as manualTrades).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- hermetic store (no disk) ----
const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f: string, d: unknown) => (_disk.has(f) ? structuredClone(_disk.get(f)) : structuredClone(d)),
  saveJSON: (f: string, v: unknown) => { _disk.set(f, v); },
}));

import {
  remember, continuityOf, applySignalTrustGuards, holdingPositions, buildHoldingCard,
  pinHoldingOnBoard, normSym, __resetSignalMemoryForTests,
  OB_RSI, OS_RSI, OB_RSI_EXTREME, FLIP_COOLDOWN_MS,
} from '../server/ai/signalMemory.js';
import { buildSignal } from '../server/ai/ensemble.js';

const T0 = 1_800_000_000_000; // fixed epoch anchor

function consensusOf(over = {}) {
  return {
    side: 'LONG', dir: 1, confidence: 78, agreement: 0.8, participation: 0.9,
    grade: 'STRONG', voters: 10, participating: 10, totalModels: 14,
    bullWeight: 9, bearWeight: 1, summary: 'LONG 78% · 10/14 models voting',
    ...over,
  };
}

beforeEach(() => {
  _disk.clear();
  __resetSignalMemoryForTests();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

describe('v12.4 continuity store — remember / continuityOf', () => {
  it('tracks firstSeenAt on first directional view and keeps it stable across re-observations', () => {
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 78, grade: 'STRONG', ltp: 0.4385 });
    vi.setSystemTime(T0 + 12 * 60_000);
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 74, grade: 'ACTION', ltp: 0.44 });
    const c = continuityOf('FUTURES', 'WLD');
    expect(c).not.toBeNull();
    expect(c!.side).toBe('LONG');
    expect(c!.firstSeenAt).toBe(T0); // age anchors at the FIRST sighting
    expect(c!.ageMs).toBe(12 * 60_000);
    expect(c!.lastConf).toBe(74);
    expect(c!.flips24h).toBe(0);
  });

  it('detects a side flip: prevSide recorded, age RESET, flip history bounded to 24h', () => {
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 78, grade: 'STRONG' });
    vi.setSystemTime(T0 + 30 * 60_000);
    remember('FUTURES', 'WLD', { side: 'SHORT', confidence: 71, grade: 'STRONG' });
    const c = continuityOf('FUTURES', 'WLD')!;
    expect(c.side).toBe('SHORT');
    expect(c.prevSide).toBe('LONG');
    expect(c.flippedAt).toBe(T0 + 30 * 60_000);
    expect(c.ageMs).toBe(0); // the SHORT is brand new
    expect(c.flips.length).toBe(1);
    expect(c.flips[0]).toMatchObject({ from: 'LONG', to: 'SHORT' });
    // 25h-old flips fall out of the 24h window
    vi.setSystemTime(T0 + 30 * 60_000 + 25 * 3600_000);
    const c2 = continuityOf('FUTURES', 'WLD')!;
    expect(c2.flips24h).toBe(0);
  });

  it('FLAT clears the current side but PRESERVES the last directional view (the pinned-card read)', () => {
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 78, grade: 'STRONG' });
    vi.setSystemTime(T0 + 8 * 60_000);
    remember('FUTURES', 'WLD', { side: 'FLAT', confidence: 0, grade: 'NEUTRAL' });
    const c = continuityOf('FUTURES', 'WLD')!;
    expect(c.side).toBeNull();
    expect(c.ageMs).toBeNull();
    expect(c.lastDirSide).toBe('LONG'); // "AI abhi neutral hai (last view: LONG 8m pehle)"
    expect(c.lastDirAgeMs).toBe(8 * 60_000);
    // a later opposite view counts as a FLIP vs the last directional side
    vi.setSystemTime(T0 + 10 * 60_000);
    remember('FUTURES', 'WLD', { side: 'SHORT', confidence: 65, grade: 'ACTION' });
    const c2 = continuityOf('FUTURES', 'WLD')!;
    expect(c2.prevSide).toBe('LONG');
    expect(c2.flips.length).toBe(1);
  });

  it('keys are per-market (WLD on FUTURES ≠ WLD on CRYPTO) and symbols normalize', () => {
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 60, grade: 'ACTION' });
    remember('CRYPTO', 'WLD', { side: 'SHORT', confidence: 55, grade: 'ACTION' });
    expect(continuityOf('FUTURES', 'WLD')!.side).toBe('LONG');
    expect(continuityOf('CRYPTO', 'WLD')!.side).toBe('SHORT');
    expect(normSym('B-WLD_USDT')).toBe('WLD');
    expect(normSym('WLDINR')).toBe('WLD');
    expect(normSym('NVDA-USD')).toBe('NVDA');
  });
});

describe('v12.4 applySignalTrustGuards — OB/OS hard guard', () => {
  it('LONG at RSI ≥ 70 is suppressed: grade capped to WATCH, confidence floored, obOs attached + summary says so', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ side: 'LONG', dir: 1, confidence: 82, grade: 'STRONG' }),
      ctx: { ltp: 0.4385, ind: { rsi: 74.3 } },
    })!;
    expect(out.grade).toBe('WATCH');
    expect(out.confidence).toBeLessThanOrEqual(50);
    expect(out.obOs).toMatchObject({ tag: 'OVERBOUGHT', rsi: 74.3 });
    expect(out.summary).toContain('OVERBOUGHT');
    expect(out.side).toBe('LONG'); // side/ltp untouched — plans stay valid
  });

  it('extreme overbought (RSI ≥ 78) cuts confidence harder', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ confidence: 90, grade: 'STRONG' }),
      ctx: { ltp: 1, ind: { rsi: OB_RSI_EXTREME + 1 } },
    })!;
    expect(out.grade).toBe('WATCH');
    expect(out.confidence).toBeLessThanOrEqual(42);
    expect(out.obOs?.extreme).toBe(true);
  });

  it('SHORT at RSI ≤ 30 is suppressed the same way (oversold bounce risk)', () => {
    const out = applySignalTrustGuards({
      market: 'CRYPTO', symbol: 'BTC',
      consensus: consensusOf({ side: 'SHORT', dir: -1, confidence: 76, grade: 'STRONG' }),
      ctx: { ltp: 60000, ind: { rsi: OS_RSI - 2 } },
    })!;
    expect(out.grade).toBe('WATCH');
    expect(out.obOs).toMatchObject({ tag: 'OVERSOLD' });
  });

  it('neutral RSI (30 < rsi < 70) leaves the consensus untouched apart from the age attach', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ confidence: 82, grade: 'STRONG' }),
      ctx: { ltp: 0.44, ind: { rsi: 58 } },
    })!;
    expect(out.grade).toBe('STRONG');
    expect(out.confidence).toBe(82);
    expect(out.obOs).toBeUndefined();
    expect(out.signalAge).toBeDefined();
  });

  it('LTF RSI wins over the daily RSI (the trading timeframe is what the entry rides on)', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf(),
      ctx: { ltp: 0.44, ind: { rsi: 55 } },
      ltf: { rsi: 73 },
    })!;
    expect(out.obOs).toMatchObject({ tag: 'OVERBOUGHT' });
  });

  it('a NEUTRAL/low grade is never UPGRADED, and a WATCH LONG below the RSI guard is untouched grade-wise', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ side: 'LONG', dir: 1, confidence: 40, grade: 'NEUTRAL' }),
      ctx: { ltp: 1, ind: { rsi: 75 } },
    })!;
    expect(out.grade).toBe('NEUTRAL'); // cap only ever TIGHTENS
    expect(out.obOs).toBeDefined();
  });
});

describe('v12.4 applySignalTrustGuards — flip cooldown (anti-whipsaw)', () => {
  it('a side that JUST flipped (< hard window) is capped to WATCH + freshFlip flag', () => {
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 78, grade: 'STRONG' });
    vi.setSystemTime(T0 + 90_000); // flip 90s ago
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ side: 'SHORT', dir: -1, confidence: 80, grade: 'STRONG' }),
      ctx: { ltp: 0.43, ind: { rsi: 50 } },
    })!;
    expect(out.grade).toBe('WATCH');
    expect(out.freshFlip).toMatchObject({ from: 'LONG', to: 'SHORT' });
    expect(out.confidence).toBeLessThanOrEqual(52);
    expect(out.summary).toContain('FLIP');
  });

  it('2-5m after a flip (v21.13 windows): soft confidence haircut only, no grade cap', () => {
    // v21.13 retune: hard 5m→2m, soft 10m→5m (5min+60s-cache card purani
    // side 6min tak dikhata tha reversal me). 7m ab CLEAN hai — soft
    // window ke andar aane ke liye 4m use hota hai.
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 78, grade: 'STRONG' });
    vi.setSystemTime(T0 + 1000); // the SHORT first appears here (flip recorded)
    applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ side: 'SHORT', dir: -1, confidence: 80, grade: 'STRONG' }),
      ctx: { ltp: 0.43, ind: { rsi: 50 } },
    });
    vi.setSystemTime(T0 + 4 * 60_000); // 4m after the flip — inside the soft window
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ side: 'SHORT', dir: -1, confidence: 80, grade: 'STRONG' }),
      ctx: { ltp: 0.43, ind: { rsi: 50 } },
    })!;
    expect(out.grade).toBe('STRONG');
    expect(out.confidence).toBe(80 - 8);
    expect(out.freshFlip).toBeUndefined();
  });

  it(`a flip older than ${Math.round(FLIP_COOLDOWN_MS / 60000)}m+soft window passes clean`, () => {
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 78, grade: 'STRONG' });
    vi.setSystemTime(T0 + 1000); // the SHORT first appears here (flip recorded)
    applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ side: 'SHORT', dir: -1, confidence: 80, grade: 'STRONG' }),
      ctx: { ltp: 0.43, ind: { rsi: 50 } },
    });
    vi.setSystemTime(T0 + 12 * 60_000); // 12m after the flip — clean
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ side: 'SHORT', dir: -1, confidence: 80, grade: 'STRONG' }),
      ctx: { ltp: 0.43, ind: { rsi: 50 } },
    })!;
    expect(out.grade).toBe('STRONG');
    expect(out.confidence).toBe(80);
  });

  it('a FIRST-EVER direction (no prevSide) is not treated as a flip', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'NEWCOIN',
      consensus: consensusOf(),
      ctx: { ltp: 1, ind: { rsi: 50 } },
    })!;
    expect(out.freshFlip).toBeUndefined();
    expect(out.grade).toBe('STRONG');
  });

  it('FLAT consensus is remembered but never guarded (no flags, no grade change)', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'WLD',
      consensus: consensusOf({ side: 'FLAT', dir: 0, confidence: 0, grade: 'NEUTRAL' }),
      ctx: { ltp: 0.44, ind: { rsi: 75 } },
    })!;
    expect(out.obOs).toBeUndefined();
    expect(out.grade).toBe('NEUTRAL');
    expect(continuityOf('FUTURES', 'WLD')!.side).toBeNull();
  });
});

describe('v12.4 wire — buildSignal forwards the trust fields', () => {
  it('signalAge / obOs / freshFlip ride the payload to the card', () => {
    const sig = buildSignal({
      symbol: 'WLD', market: 'FUTURES',
      ctx: { ltp: 0.4385, changePct: -2.1 },
      votes: [],
      consensus: consensusOf({
        confidence: 50, grade: 'WATCH',
        signalAge: { firstSeenAt: T0 - 300_000, lastSeenAt: T0, ageMs: 300_000, flips24h: 2 },
        obOs: { tag: 'OVERBOUGHT', rsi: 74.3, extreme: false },
        freshFlip: { from: 'SHORT', to: 'LONG', ageSec: 45 },
      }),
      plan: null,
    });
    expect(sig.signalAge).toMatchObject({ flips24h: 2 });
    expect(sig.obOs).toMatchObject({ tag: 'OVERBOUGHT' });
    expect(sig.freshFlip).toMatchObject({ from: 'SHORT', to: 'LONG' });
    expect(sig.executable).toBe(false); // WATCH + no plan → never executable
  });
});

describe('v12.4 holdingPositions — the pinning source', () => {
  it('reads OPEN journal positions + manual trades for the market, normalizing sides and symbols', () => {
    _disk.set('ai-trading-journal.json', {
      entries: [],
      positions: [
        { pair: 'WLD-USDT', symbol: 'WLD', market: 'FUTURES', side: 'LONG', status: 'OPEN', entryPrice: 0.4385, qty: 692, mode: 'live', source: 'manual', openedAt: T0 - 3600_000 },
        { pair: 'BTCINR', market: 'CRYPTO', side: 'SHORT', status: 'OPEN', entryPrice: 600000, qty: 0.01, mode: 'paper', source: 'auto', openedAt: T0 - 60_000 },
        { pair: 'X-INR', market: 'CRYPTO', side: 'LONG', status: 'CLOSED', entryPrice: 1, qty: 1 }, // closed → ignored
        { pair: 'RELIANCE', symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', status: 'OPEN', entryPrice: 1400, qty: 10, openedAt: T0 },
      ],
    });
    _disk.set('manual-trades.json', {
      trades: [
        { id: 9, symbol: 'WLD', market: 'FUTURES', side: 'BUY', entryPrice: 0.4371, qty: 300, status: 'OPEN', entryTime: T0 - 7200_000 },
        { id: 10, symbol: 'HBAR', market: 'FUTURES', side: 'SELL', entryPrice: 0.1512, qty: 1000, status: 'CLOSED' },
      ],
    });
    const fut = holdingPositions('FUTURES');
    expect(fut).toHaveLength(2); // journal WLD + manual WLD (closed HBAR ignored)
    expect(fut[0]).toMatchObject({ symbol: 'WLD', side: 'LONG', entryPrice: 0.4385, qty: 692, via: 'journal' });
    expect(fut[1]).toMatchObject({ symbol: 'WLD', side: 'LONG', via: 'manual', entryPrice: 0.4371 });
    const cry = holdingPositions('CRYPTO');
    expect(cry).toHaveLength(1);
    expect(cry[0]).toMatchObject({ symbol: 'BTC', side: 'SHORT' }); // BTCINR normalized, side kept
    expect(holdingPositions('GLOBALFUTURES')).toHaveLength(0);
  });

  it('degrades to empty on unreadable stores (never throws)', () => {
    _disk.set('ai-trading-journal.json', null as never);
    _disk.set('manual-trades.json', { trades: 'garbage' } as never);
    expect(() => holdingPositions('FUTURES')).not.toThrow();
  });
});

describe('v12.4 pinHoldingOnBoard + buildHoldingCard — traded symbols never vanish', () => {
  it('stamps an existing board card with holding and pins a missing symbol (honest card)', () => {
    _disk.set('ai-trading-journal.json', {
      entries: [],
      positions: [
        { pair: 'WLD-USDT', symbol: 'WLD', market: 'FUTURES', side: 'LONG', status: 'OPEN', entryPrice: 0.4385, qty: 692, mode: 'live', source: 'manual', openedAt: T0 - 3600_000 },
      ],
    });
    remember('FUTURES', 'WLD', { side: 'LONG', confidence: 71, grade: 'STRONG', ltp: 0.4401 });
    const board = [
      { symbol: 'BTC', market: 'FUTURES', side: 'LONG', grade: 'STRONG', confidence: 80, executable: true },
    ];
    pinHoldingOnBoard(board as never, 'FUTURES', { maxPinned: 4 });
    // existing BTC card got a stamp? (no BTC position here — only WLD)
    const wld = board.find(s => s.symbol === 'WLD');
    expect(wld).toBeDefined(); // the pin landed
    expect(wld!.holdingOnly).toBe(true);
    expect(wld!.holding).toMatchObject({ side: 'LONG', entryPrice: 0.4385, qty: 692 });
    expect(['WATCH', 'NEUTRAL']).toContain(wld!.grade); // never above WATCH
    expect(wld!.executable).toBe(false); // context, not a trade call
    expect(wld!.plan).toBeNull();
    expect(wld!.summary).toContain('OPEN POSITION PIN');
    expect(wld!.summary).toContain('AI view'); // the current AI view stamped
  });

  it('stamps the HOLDING badge on a card that IS on the board', () => {
    _disk.set('ai-trading-journal.json', {
      entries: [],
      positions: [{ pair: 'BTC-USDT', symbol: 'BTC', market: 'FUTURES', side: 'LONG', status: 'OPEN', entryPrice: 60000, qty: 0.5, mode: 'live', openedAt: T0 - 600_000 }],
    });
    const board = [
      { symbol: 'BTC', market: 'FUTURES', side: 'LONG', grade: 'STRONG', confidence: 80, executable: true },
    ];
    pinHoldingOnBoard(board as never, 'FUTURES');
    expect(board).toHaveLength(1); // stamped, not duplicated
    expect(board[0].holding).toMatchObject({ side: 'LONG', entryPrice: 60000, qty: 0.5 });
    expect(board[0].holdingOnly).toBeUndefined();
  });

  it('bounds the pins (maxPinned) so a full book cannot flood the board', () => {
    _disk.set('ai-trading-journal.json', {
      entries: [],
      positions: ['A', 'B', 'C', 'D', 'E', 'F'].map(s => ({
        pair: `${s}-USDT`, symbol: s, market: 'FUTURES', side: 'LONG', status: 'OPEN', entryPrice: 1, qty: 1, openedAt: T0,
      })),
    });
    const board: object[] = [];
    pinHoldingOnBoard(board as never, 'FUTURES', { maxPinned: 4 });
    expect(board).toHaveLength(4);
  });

  it('a held symbol with NO fresh AI view pins with the honest stale note and position side', () => {
    _disk.set('ai-trading-journal.json', {
      entries: [],
      positions: [{ pair: 'DOGE-USDT', symbol: 'DOGE', market: 'FUTURES', side: 'SHORT', status: 'OPEN', entryPrice: 0.12, qty: 5000, openedAt: T0 - 86_400_000 }],
    });
    const board: object[] = [];
    pinHoldingOnBoard(board as never, 'FUTURES');
    const card = board[0] as Record<string, unknown>;
    expect(card.side).toBe('SHORT'); // position side carries the card
    expect(card.summary).toContain('stale');
    expect(card.holding).toMatchObject({ side: 'SHORT', qty: 5000 });
  });

  it('v12.7: a held LONG with a fresh OPPOSITE AI view — the card side STAYS LONG (the AI view rides the aiView sub-chip, never the card)', () => {
    // THE perception bug this locks out: the old buildHoldingCard headlined
    // the AI's CURRENT view — a held LONG rendered under a SHORT-labeled
    // card after the consensus flipped, which the user fairly read as
    // "direction galat / long pe trade liya par short dikha raha hai".
    _disk.set('ai-trading-journal.json', {
      entries: [],
      positions: [{ pair: 'WLD-USDT', symbol: 'WLD', market: 'FUTURES', side: 'LONG', status: 'OPEN', entryPrice: 0.4385, qty: 692, mode: 'live', source: 'manual', openedAt: T0 - 1800_000 }],
    });
    // fresh OPPOSITE view — SHORT conviction while the user holds LONG
    remember('FUTURES', 'WLD', { side: 'SHORT', confidence: 78, grade: 'ACTION', ltp: 0.4102 });
    const board: object[] = [];
    pinHoldingOnBoard(board as never, 'FUTURES');
    const card = board[0] as Record<string, unknown>;
    expect(card.side).toBe('LONG'); // the POSITION headlines, not the AI view
    expect(card.aiView).toMatchObject({ side: 'SHORT', fresh: true }); // the view demoted to a sub-chip
    expect(card.holding).toMatchObject({ side: 'LONG' });
    expect(card.executable).toBe(false); // still context, never a trade call
    expect(String(card.summary)).toContain('aapki LONG position');
  });

  it('v12.7: held SHORT + fresh SAME-side AI view — aiView mirrors the position (no confusing chip)', () => {
    _disk.set('ai-trading-journal.json', {
      entries: [],
      positions: [{ pair: 'HBAR-USDT', symbol: 'HBAR', market: 'FUTURES', side: 'SHORT', status: 'OPEN', entryPrice: 0.22, qty: 1000, openedAt: T0 - 900_000 }],
    });
    remember('FUTURES', 'HBAR', { side: 'SHORT', confidence: 66, grade: 'WATCH', ltp: 0.2150 });
    const board: object[] = [];
    pinHoldingOnBoard(board as never, 'FUTURES');
    const card = board[0] as Record<string, unknown>;
    expect(card.side).toBe('SHORT');
    expect(card.aiView).toMatchObject({ side: 'SHORT' });
  });
});

// ============================================================
// v12.5 DIRECTION-TIMING ENGINE (chase guard) — the "long bola
// tho short chala gaya" fix. The ensemble CONFIRMS a move that
// already happened; the entry lands at local exhaustion; the
// mean-reversion that follows reads as "direction galat". The
// structural read (ATR-distance from the mean + one-way candle
// run) suppresses those entries — RSI guard ke saath poora
// coverage (RSI 63 on a +6% vertical run is still a top-tick).
// ============================================================
import {
  entryTimingRead,
  CHASE_EXT_ATR_HARD, CHASE_EXT_ATR_SOFT, CHASE_HARD_CONF_CAP, CHASE_SOFT_CONF_PENALTY,
  CHASE_RUN_BARS, CHASE_RUN_ATR,
  QUALITY_PULLBACK_CONF_BOOST, QUALITY_EXTENDED_CONF_PENALTY,
  QUALITY_PULLBACK_LO, QUALITY_PULLBACK_HI, QUALITY_EXTENDED_LO,
} from '../server/ai/entryTiming.js';
import { evaluateExecutionGate } from '../server/ai/ensemble.js';

// rising tape with pullbacks (a REAL run — not a monotonic ramp:
// every 4th candle breathes, RSI stays honest)
function risingCandles(n = 40, start = 100, step = 1.2) {
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const breathe = i % 4 === 3 ? -step * 0.4 : step;
    px = px + breathe;
    out.push({ time: 1700000000 + i * 3600, open: px - breathe, high: px + 0.3, low: px - breathe - 0.3, close: px, volume: 1000 });
  }
  return out;
}

describe('v12.5 entryTimingRead — the structural chase verdict (pure)', () => {
  it('flags a LONG stretched ≥ 2.5×ATR above EMA20 as HARD (the RSI-63 gap the OB/OS guard misses)', () => {
    const r = entryTimingRead({ side: 'LONG', ltp: 112, ema20: 100, atr: 4, rsi: 63, candles: risingCandles() });
    expect(r?.severity).toBe('HARD'); // (112-100)/4 = 3.0 ≥ 2.5
    expect(r?.extAtr).toBe(3);
    expect(r?.ref).toBe('EMA20');
    expect(r?.reason).toContain('above');
  });

  it('flags the SHORT mirror: ≥ 2.5×ATR below the mean is HARD', () => {
    const r = entryTimingRead({ side: 'SHORT', ltp: 88, ema20: 100, atr: 4, rsi: 37, candles: risingCandles().map(c => ({ ...c, close: 200 - c.close })) });
    expect(r?.severity).toBe('HARD');
    expect(r?.extAtr).toBe(-3);
  });

  it('RSI assist: 64+ with ≥1.9×ATR extension is HARD even below the 2.5 bar', () => {
    const r = entryTimingRead({ side: 'LONG', ltp: 104, ema20: 100, atr: 2, rsi: 66, candles: risingCandles() });
    expect(r?.severity).toBe('HARD'); // ext = 2.0 ≥ 1.9 with rsi 66 ≥ 64
  });

  it('six one-way candles covering ≥3 ATR is HARD even at a modest extension', () => {
    // 6 straight up closes, each ~0.7 ATR → runAtr ≈ 4.2 ≥ 3, ext small
    const cl = [];
    for (let i = 0; i < 30; i++) cl.push({ time: i, open: 0, high: 0, low: 0, close: 100 + i * 0.6, volume: 1 });
    const r = entryTimingRead({ side: 'LONG', ltp: 117.4, ema20: 109, atr: 1, rsi: 58, candles: cl });
    expect(r?.runBars).toBeGreaterThanOrEqual(CHASE_RUN_BARS);
    expect(r?.runAtr).toBeGreaterThanOrEqual(CHASE_RUN_ATR);
    expect(r?.severity).toBe('HARD');
  });

  it('SOFT: 1.8–2.5×ATR extension (no RSI assist, no run) is a haircut, not a lock', () => {
    const r = entryTimingRead({ side: 'LONG', ltp: 104, ema20: 100, atr: 2.2, rsi: 55, candles: risingCandles(40, 100, 0.5) });
    expect(r?.severity).toBe('SOFT'); // ext = 1.82
  });

  it('a calm tape (price near the mean) carries NO verdict', () => {
    const r = entryTimingRead({ side: 'LONG', ltp: 100.8, ema20: 100, atr: 2, rsi: 52, candles: risingCandles(40, 99, 0.05) });
    expect(r?.severity).toBeNull();
  });

  it('India desk anchors to the session VWAP, not EMA20', () => {
    const r = entryTimingRead({ side: 'LONG', market: 'INDIA', ltp: 112, ema20: 90, vwap: 100, atr: 4, rsi: 60 });
    expect(r?.ref).toBe('VWAP');
    expect(r?.extAtr).toBe(3);
    expect(r?.severity).toBe('HARD');
  });

  it('degrades silently: no side / no data → null, never throws', () => {
    expect(entryTimingRead({ side: 'FLAT', ltp: 100, ema20: 100, atr: 2 })).toBeNull();
    expect(entryTimingRead({ side: 'LONG' })).toBeNull();
    expect(entryTimingRead(null as never)).toBeNull();
  });
});

describe('v12.5 applySignalTrustGuards — chase discipline on the consensus', () => {
  it('a STRONG LONG on a +3×ATR extended leg (RSI 63 — under the OB/OS bar) is capped to WATCH with the chasing stamp', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'HBAR',
      consensus: consensusOf({ side: 'LONG', dir: 1 }),
      ctx: { ltp: 112, candles: risingCandles() },
      ltf: { ltp: 112, ema20: 100, atr: 4, rsi: 63 },
    });
    expect(out.grade).toBe('WATCH');
    expect(out.confidence).toBeLessThanOrEqual(CHASE_HARD_CONF_CAP);
    expect(out.chasing).toMatchObject({ severity: 'HARD', extAtr: 3 });
    expect(out.summary).toContain('CHASING');
    // never flips the side / ltp — the plan stays directionally valid
    expect(out.side).toBe('LONG');
  });

  it('SHORT mirror: a STRONG SHORT on a −3×ATR dump is capped (knife-cut suppressed)', () => {
    const out = applySignalTrustGuards({
      market: 'CRYPTO', symbol: 'WLD',
      consensus: consensusOf({ side: 'SHORT', dir: -1 }),
      ctx: { ltp: 88, candles: risingCandles().map(c => ({ ...c, close: 200 - c.close })) },
      ltf: { ltp: 88, ema20: 100, atr: 4, rsi: 35 },
    });
    expect(out.grade).toBe('WATCH');
    expect(out.chasing).toMatchObject({ severity: 'HARD' });
    expect(out.side).toBe('SHORT');
  });

  it('SOFT extension takes the confidence haircut without the grade cap', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'BTC',
      consensus: consensusOf({ side: 'LONG', dir: 1 }),
      ctx: { ltp: 104, candles: risingCandles(40, 100, 0.5) },
      ltf: { ltp: 104, ema20: 100, atr: 2.2, rsi: 55 },
    });
    expect(out.grade).toBe('STRONG');
    expect(out.confidence).toBe(78 - CHASE_SOFT_CONF_PENALTY);
    expect(out.chasing?.severity).toBe('SOFT');
  });

  it('a calm consensus at the mean gets the v12.6 PULLBACK boost (no chase stamp)', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'BTC',
      consensus: consensusOf({ side: 'LONG', dir: 1 }),
      ctx: { ltp: 100.8, candles: risingCandles(40, 99, 0.05) },
      ltf: { ltp: 100.8, ema20: 100, atr: 2, rsi: 52 },
    });
    expect(out.grade).toBe('STRONG');
    // v12.6: extAtr = +0.4 → PULLBACK band → +4 confidence (78 → 82)
    expect(out.confidence).toBe(78 + QUALITY_PULLBACK_CONF_BOOST);
    expect(out.chasing?.severity ?? null).toBeNull();
    expect(out.entryQuality).toMatchObject({ band: 'PULLBACK', extAtr: 0.4, ref: 'EMA20' });
    expect(out.summary).toContain('PULLBACK');
  });

  it('v12.6 EXTENDED band (1.5–1.8×ATR, under the SOFT line) takes the light haircut + stamp', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'BTC',
      consensus: consensusOf({ side: 'LONG', dir: 1 }),
      ctx: { ltp: 103.3, candles: risingCandles(40, 100, 0.4) },
      ltf: { ltp: 103.3, ema20: 100, atr: 2, rsi: 58 },
    });
    expect(out.grade).toBe('STRONG'); // under the SOFT chase line — grade intact
    expect(out.chasing?.severity ?? null).toBeNull();
    expect(out.entryQuality).toMatchObject({ band: 'EXTENDED', extAtr: 1.65 });
    expect(out.confidence).toBe(78 - QUALITY_EXTENDED_CONF_PENALTY);
  });

  it('v12.6 PULLBACK never fires on a chased signal (HARD cap wins, no boost)', () => {
    const out = applySignalTrustGuards({
      market: 'FUTURES', symbol: 'HBAR',
      consensus: consensusOf({ side: 'LONG', dir: 1 }),
      ctx: { ltp: 112, candles: risingCandles() },
      ltf: { ltp: 112, ema20: 100, atr: 4, rsi: 63 },
    });
    expect(out.grade).toBe('WATCH');
    expect(out.confidence).toBeLessThanOrEqual(CHASE_HARD_CONF_CAP);
    expect(out.chasing).toMatchObject({ severity: 'HARD', extAtr: 3 });
    expect(out.entryQuality ?? null).toBeNull(); // 3×ATR is NOT in any quality band
  });

  it('buildSignal forwards the chasing verdict to the card', () => {
    const sig = buildSignal({
      symbol: 'HBAR', market: 'FUTURES',
      ctx: { ltp: 112, changePct: 6.4 },
      votes: [],
      consensus: consensusOf({ side: 'LONG', dir: 1, grade: 'WATCH', confidence: 48, chasing: { side: 'LONG', extAtr: 3, ref: 'EMA20', runBars: 5, runAtr: 3.6, severity: 'HARD', reason: 'price 3×ATR above EMA20' } }),
      plan: { entry: 112, stopLoss: 108, target1: 116, target2: 120, riskPct: 2 },
    });
    expect(sig.chasing).toMatchObject({ severity: 'HARD', extAtr: 3 });
  });

  it('buildSignal forwards the v12.6 entryQuality verdict to the card', () => {
    const sig = buildSignal({
      symbol: 'BTC', market: 'FUTURES',
      ctx: { ltp: 100.8, changePct: 0.4 },
      votes: [],
      consensus: consensusOf({ side: 'LONG', dir: 1, grade: 'STRONG', confidence: 82, entryQuality: { band: 'PULLBACK', extAtr: 0.4, ref: 'EMA20', note: 'price 0.4×ATR above EMA20 — pullback zone' } }),
      plan: { entry: 100.8, stopLoss: 98.8, target1: 102.8, target2: 104.8, riskPct: 2 },
    });
    expect(sig.entryQuality).toMatchObject({ band: 'PULLBACK', extAtr: 0.4 });
  });
});

describe('v12.5 execution gate — the chase veto (honest journal reason)', () => {
  const baseSignal = {
    side: 'LONG', market: 'FUTURES', generatedAt: T0, grade: 'STRONG', confidence: 82, agreement: 0.9,
    plan: { entry: 112, stopLoss: 108, target1: 116, target2: 120, riskPct: 2 },
  };
  const chasingHard = { ...baseSignal, chasing: { side: 'LONG', extAtr: 3, ref: 'EMA20', runBars: 5, runAtr: 3.6, severity: 'HARD', reason: 'price 3×ATR above EMA20 — chase entry (top-tick risk)' } };

  it('refuses a HARD-chasing entry with the readable reason (live path)', () => {
    const v = evaluateExecutionGate(chasingHard, { side: 'LONG', venue: 'FUTURES', requireStrong: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('chasing guard');
    expect(v.reason).toContain('pullback');
  });

  it('refuses it for PRACTICE too — rehearsing a top-tick chase is the same bad habit', () => {
    const v = evaluateExecutionGate(chasingHard, { side: 'LONG', venue: 'FUTURES', requireStrong: false, practice: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('chasing guard');
  });

  it('a SOFT-chasing (extended) signal is NOT vetoed — haircut already applied on the board', () => {
    const v = evaluateExecutionGate({ ...baseSignal, chasing: { side: 'LONG', extAtr: 2, ref: 'EMA20', runBars: 3, runAtr: 2, severity: 'SOFT', reason: '2×ATR above EMA20' } }, { side: 'LONG', venue: 'FUTURES', requireStrong: true });
    expect(v.ok).toBe(true);
  });

  it('a clean signal with no chasing stamp passes exactly as before', () => {
    const v = evaluateExecutionGate(baseSignal, { side: 'LONG', venue: 'FUTURES', requireStrong: true });
    expect(v.ok).toBe(true);
    expect(v.reason).toContain('STRONG');
  });
});
