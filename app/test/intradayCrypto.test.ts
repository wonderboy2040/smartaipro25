// ============================================================
// intradayCrypto tests — 2026-09 multi-market pass (CRYPTO 24/7)
//   • time.js market-aware clocks (UTC day, 24/7 gate, phases)
//   • engine: TV crypto scanner batch + CoinDCX INR anchor scaling
//   • engine: crypto analysis (fractional sizing, no IST gates)
//   • paperTrading: fractional crypto trades, no 15:10 EOD sq-off,
//     UTC day rollover, per-market watcher routing
//   • trackRecord: crypto rows never EOD-close at NSE close
// No real network: fetch is stubbed per-test; store mocked.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ signals: [], trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));

const { isMarketOpenFor, dayKeyFor, marketPhaseFor, freshEntriesAllowedFor } =
  await import('../server/intraday/time.js');
const { analyzeIntradayFromScanner, fetchIntradayDataBatch, CRYPTO_UNIVERSE, isCryptoSymbolBase } =
  await import('../server/intraday/engine.js');
const paper = await import('../server/intraday/paperTrading.js');
const track = await import('../server/intraday/trackRecord.js');

// IST-deterministic times:
//  Sat 12:00 IST = Sat 06:30 UTC — crypto open, NSE closed (weekend)
//  Mon 14:45 IST = Mon 09:15 UTC — NSE dead-zone window
//  Mon 15:35 IST = Mon 10:05 UTC — after NSE EOD reconcile
const SAT_NOON_IST = new Date('2026-08-29T06:30:00Z').getTime();
const MON_DEADZONE_IST = new Date('2026-08-31T09:15:00Z').getTime();
const MON_AFTER_EOD_IST = new Date('2026-08-31T10:05:00Z').getTime();

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// ---------------- time.js — market-aware clocks ----------------
describe('time.js — multi-market session/dayKey/phase', () => {
  it('crypto market is ALWAYS open (weekend, night, holidays)', () => {
    expect(isMarketOpenFor('CRYPTO', new Date(SAT_NOON_IST))).toBe(true);
    expect(isMarketOpenFor('CRYPTO', new Date('2026-08-30T02:00:00Z'))).toBe(true); // Sunday 07:30 IST
  });

  it('INDIA market follows NSE hours; crypto dayKey is the UTC calendar day', () => {
    expect(isMarketOpenFor('INDIA', new Date(SAT_NOON_IST))).toBe(false);
    // 2026-08-29 06:30 UTC → UTC day 2026-08-29, IST day 2026-08-29 (12:00 IST)
    expect(dayKeyFor('CRYPTO', new Date('2026-08-29T23:30:00Z'))).toBe('2026-08-29'); // 05:00 IST next day
    expect(dayKeyFor('INDIA', new Date('2026-08-29T23:30:00Z'))).toBe('2026-08-30'); // IST calendar day
  });

  it('crypto phase is always full; fresh entries never blocked', () => {
    vi.setSystemTime(MON_DEADZONE_IST);
    expect(marketPhaseFor('CRYPTO')).toBe('full');
    expect(marketPhaseFor('INDIA')).toBe('power-hour'); // 14:45 IST → power-hour (14:30+)
    expect(freshEntriesAllowedFor('CRYPTO')).toBe(true);
    expect(freshEntriesAllowedFor('INDIA')).toBe(true); // 14:45 — still before the 15:00 cutoff
    vi.setSystemTime(MON_AFTER_EOD_IST); // 15:35 IST
    expect(freshEntriesAllowedFor('CRYPTO')).toBe(true); // crypto NEVER blocks
    expect(freshEntriesAllowedFor('INDIA')).toBe(false); // after 15:00 IST
  });

  it('isCryptoSymbolBase routes the known majors', () => {
    expect(isCryptoSymbolBase('BTC')).toBe(true);
    expect(isCryptoSymbolBase('MATIC')).toBe(true);
    expect(isCryptoSymbolBase('RELIANCE')).toBe(false);
    expect(CRYPTO_UNIVERSE.length).toBeGreaterThanOrEqual(12);
  });
});

// ---------------- engine: crypto data batch + analysis ----------------
describe('engine — CRYPTO TV batch + CoinDCX INR anchor scaling', () => {
  it('fetchIntradayDataBatch(market:CRYPTO) scales TV USD indicators into INR via the anchor', async () => {
    // TV crypto scanner: BTCUSDT row (USD) — bullish A+-capable shape.
    const tvRow = (sym) => ({
      s: `BINANCE:${sym}USDT`,
      d: [50000, 49800, 50600, 49500, 12000, 1.5,          // close open high low volume change
        50100, 49900, 49800, 49500,                          // ema10 ema20 sma20 sma50
        61, 80, 40,                                          // rsi macd macdSignal
        350, 49900,                                          // atr vwap
        27, 25, 10,                                          // adx +di -di
        1.8,                                                 // relVolume
        49900, 49400, 50400,                                 // pivots
        1, 50000],                                           // recommend last
    });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('scanner.tradingview.com/crypto/scan')) {
        return { ok: true, json: async () => ({ data: [tvRow('BTC'), tvRow('ETH')] }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fetchCoinDcxTickers = vi.fn(async () => [
      { market: 'BTCINR', last_price: '4350000', change_24_hour: '1.25', high: '4400000', low: '4300000', volume: '77' },
      { market: 'ETHINR', last_price: '150000', change_24_hour: '-0.5', high: '155000', low: '148000', volume: '9' },
    ]);

    const [tvData, cdcxData] = await fetchIntradayDataBatch(['BTC', 'ETH'], null, {
      market: 'CRYPTO', fetchCoinDcxTickers,
    });

    expect(fetchCoinDcxTickers).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // CoinDCX INR quotes: same shape as the Groww path.
    expect(cdcxData.BTC.price).toBe(4350000);
    expect(cdcxData.BTC.prevClose).toBeCloseTo(4350000 / 1.0125, 0);
    // anchor scale = 4,350,000 INR / 50,000 USDT = 87 — every USD field ×87.
    expect(tvData.BTC.close).toBeCloseTo(4350000, 0);
    expect(tvData.BTC.ema10).toBeCloseTo(50100 * 87, 0);
    expect(tvData.BTC.vwap).toBeCloseTo(49900 * 87, 0);
    expect(tvData.BTC.atr).toBeCloseTo(350 * 87, 0);
    // RSI / relVolume are scale-invariant — untouched.
    expect(tvData.BTC.rsi).toBe(61);
    expect(tvData.BTC.relVolume).toBe(1.8);
    expect(tvData.BTC.exchange).toBe('BINANCE');
    expect(tvData.ETH.close).toBeCloseTo(150000, 0);
  });

  it('crypto analysis: fractional qty sizing, no IST gates, 24/7 labels', () => {
    vi.setSystemTime(MON_DEADZONE_IST); // 14:45 IST — dead zone for NSE
    const scale = 87;
    const tvInr = {
      close: 4350000, open: 4332600, high: 4402200, low: 4306500, volume: 12000, change: 1.5,
      ema10: 50100 * scale, ema20: 49900 * scale, sma20: 49800 * scale, sma50: 49500 * scale,
      rsi: 61, macd: 80 * scale, macdSignal: 40 * scale,
      atr: 350 * scale, vwap: 49900 * scale,
      adx: 27, adxPlus: 25, adxMinus: 10, relVolume: 1.8,
      pivotMiddle: 49900 * scale, pivotS1: 49400 * scale, pivotR1: 50400 * scale,
      recommend: 1, last: 50000 * scale, exchange: 'BINANCE',
    };
    const coindcx = { price: 4350000, prevClose: 4296296.3, change: 1.25, high: 4400000, low: 4300000, volume: 77 };

    const r = analyzeIntradayFromScanner('BTC', tvInr, coindcx, {
      market: 'CRYPTO',
      regime: { regime: 'BULLISH', vixLevel: 'LOW' },
    });
    expect(r).toBeTruthy();
    expect(r.market).toBe('CRYPTO');
    expect(r.exchange).toBe('BINANCE');
    expect(r.entry).toBeCloseTo(4350000, 0);
    // Fractional sizing: 0.0001-step BTC units, not integer shares.
    expect(r.qtyPerLakh).toBeGreaterThan(0);
    expect(r.qtyPerLakh).toBeLessThan(1);
    expect(Number.isInteger(+(r.qtyPerLakh * 10000).toFixed(0))).toBe(true); // 4dp
    // 24/7 discipline.
    expect(r.sqOffBy).toBe('24/7 (no EOD sq-off)');
    expect(r.freshEntriesAllowed).toBe(true);   // 14:45 IST would block NSE
    expect(r.deadZone ?? false).toBe(false);    // would be TRUE for NSE at 14:45
    expect(r.marketPhase).toBe('full');
  });

  it('the NSE path is untouched when market is not set (regression guard)', () => {
    vi.setSystemTime(MON_DEADZONE_IST);
    const r = analyzeIntradayFromScanner('SBIN', {
      close: 812, open: 800, high: 816, low: 795, volume: 5e6, change: 1.5,
      ema10: 810, ema20: 805, sma20: 802, sma50: 790,
      rsi: 61, macd: 2.5, macdSignal: 1.5, atr: 10, vwap: 806,
      adx: 27, adxPlus: 25, adxMinus: 10, relVolume: 1.8,
      pivotMiddle: 805, pivotS1: 795, pivotR1: 820, recommend: 1, last: 812,
      exchange: 'NSE',
    }, { price: 812, prevClose: 800, change: 1.5, high: 816, low: 795, volume: 5e6 }, {});
    expect(r.market).toBe('INDIA');
    expect(r.sqOffBy).toBe('15:10 IST');
    expect(r._deadZone).toBe(true); // NSE dead-zone still penalized
  });

  it('REGRESSION: a symbol WITHOUT a CoinDCX INR anchor is DROPPED (never USD-as-₹)', async () => {
    const tvRow = (sym) => ({
      s: `BINANCE:${sym}USDT`,
      d: [50000, 49800, 50600, 49500, 12000, 1.5, 50100, 49900, 49800, 49500, 61, 80, 40, 350, 49900, 27, 25, 10, 1.8, 49900, 49400, 50400, 1, 50000],
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: [tvRow('BTC'), tvRow('LTC')] }),
    })));
    // CoinDCX has BTC but NOT LTC → LTC must be dropped from tvData.
    const fetchCoinDcxTickers = vi.fn(async () => [
      { market: 'BTCINR', last_price: '4350000', change_24_hour: '1.25', high: '4400000', low: '4300000', volume: '77' },
    ]);
    const [tvData, cdcxData] = await fetchIntradayDataBatch(['BTC', 'LTC'], null, {
      market: 'CRYPTO', fetchCoinDcxTickers,
    });
    expect(tvData.BTC).toBeTruthy();
    expect(tvData.BTC.close).toBeCloseTo(4350000, 0); // INR-scaled
    expect(tvData.LTC).toBeUndefined();               // dropped — no INR anchor
    expect(cdcxData.LTC).toBeUndefined();
  });

  it('REGRESSION: getCryptoRegime must RETURN data (const-cache reassignment bug)', async () => {
    // Mock the TV crypto scanner row for BINANCE:BTCUSDT.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ s: 'BINANCE:BTCUSDT', d: [50000, 1.9, 49800, 49900, 62] }],
      }),
    })));
    const { getCryptoRegime } = await import('../server/intraday/regime.js');
    const r = await getCryptoRegime(true);
    expect(r).toBeTruthy();               // the const-cache bug made this null
    expect(r.market).toBe('CRYPTO');
    expect(r.regime).toBe('BULLISH');     // +1.9% above VWAP/EMA
    expect(r.vixLevel).toBe('LOW');
    expect(r.btcRsi).toBe(62);
  });
});

// ---------------- paperTrading — 24/7 crypto ----------------
describe('paperTrading — crypto fractional trades, no NSE EOD square-off', () => {
  beforeEach(() => {
    paper._resetForTests();
  });

  const openBtc = () => paper.openPaperTrade({
    symbol: 'BTC', market: 'CRYPTO', direction: 'LONG',
    entry: 4350000, qty: 0.01, stopLoss: 4300000, target1: 4450000, target2: 4550000,
  });

  it('accepts fractional crypto qty (4dp) and stamps market + UTC dayKey', () => {
    vi.setSystemTime(SAT_NOON_IST);
    const { ok, trade } = openBtc();
    expect(ok).toBe(true);
    expect(trade.market).toBe('CRYPTO');
    expect(trade.qty).toBe(0.01);
    expect(trade.dayKey).toBe('2026-08-29'); // UTC day (Sat)
    // NSE whole-share rule still enforced for INDIA.
    const bad = paper.openPaperTrade({ symbol: 'SBIN', direction: 'LONG', entry: 800, qty: 0.5, stopLoss: 780 });
    expect(bad.error).toBeTruthy();
  });

  it('T1 books HALF the fractional position (0.005 BTC), not ceil(1)', () => {
    vi.setSystemTime(SAT_NOON_IST);
    openBtc();
    const events = [];
    paper.evaluatePaper({ BTC: { price: 4460000 } }, events); // T1 hit
    const t = paper.getPaperSummary().open[0];
    expect(t.status).toBe('PARTIAL');
    expect(t.parts[0].qty).toBe(0.005);
    expect(t.realizedPnl).toBeCloseTo(0.005 * (4450000 - 4350000), 0); // +₹50
  });

  it('crypto positions survive past 15:10 IST and over the weekend (no EOD sq-off)', () => {
    vi.setSystemTime(SAT_NOON_IST);
    openBtc();
    // Saturday 16:00 IST — well past the NSE 15:10 square-off.
    vi.setSystemTime(new Date('2026-08-29T10:30:00Z'));
    const events = [];
    paper.evaluatePaper({ BTC: { price: 4360000 } }, events); // between SL and T1
    const t = paper.getPaperSummary().open[0];
    expect(t.status).toBe('OPEN'); // NOT squared off
    // Same clock would close an NSE trade:
    paper.openPaperTrade({ symbol: 'SBIN', direction: 'LONG', entry: 800, qty: 10, stopLoss: 780, target1: 820, target2: 850 });
    paper.evaluatePaper({ SBIN: { price: 801 } }, events);
    const sbin = paper.getPaperSummary().closedToday.find(t => t.symbol === 'SBIN');
    expect(sbin.status).toBe('CLOSED'); // EOD_SQOFF applied to the NSE trade
    expect(sbin.closeReason).toBe('EOD_SQOFF');
  });

  it('crypto watcher routing: paperSymbolsByMarket splits Groww vs CoinDCX symbols', () => {
    vi.setSystemTime(SAT_NOON_IST);
    openBtc();
    paper.openPaperTrade({ symbol: 'ETH', market: 'CRYPTO', direction: 'LONG', entry: 150000, qty: 0.2, stopLoss: 148000, target1: 153000, target2: 156000 });
    const by = paper.paperSymbolsByMarket();
    expect(by.crypto.sort()).toEqual(['BTC', 'ETH']);
    expect(by.india).toEqual([]);
  });

  it('crypto trade auto-detects market from the symbol when the field is missing', () => {
    vi.setSystemTime(SAT_NOON_IST);
    const { ok, trade } = paper.openPaperTrade({
      symbol: 'ETH', direction: 'LONG', entry: 150000, qty: 0.2, stopLoss: 148000, target1: 153000, target2: 156000,
    });
    expect(ok).toBe(true);
    expect(trade.market).toBe('CRYPTO');
  });
});

// ---------------- trackRecord — crypto rows never NSE-EOD-close ----------------
describe('trackRecord — crypto rows never EOD-close at the NSE close', () => {
  it('a CRYPTO tracked row stays OPEN after 15:25 IST and rolls at UTC midnight', () => {
    vi.setSystemTime(SAT_NOON_IST);
    track.recordSignals([{
      symbol: 'BTC', market: 'CRYPTO', exchange: 'BINANCE', direction: 'LONG',
      entry: 4350000, stopLoss: 4300000, target1: 4450000, target2: 4550000,
      ltp: 4350000, qtyPerLakh: 0.0057, confidence: 80, quantConfidence: 80,
    }]);
    let rec = track.getTrackRecord(1);
    expect(rec.openCount).toBe(1);
    expect(rec.open[0].market).toBe('CRYPTO');

    // Saturday 16:00 IST — after the NSE EOD reconcile minute: crypto stays OPEN.
    vi.setSystemTime(new Date('2026-08-29T10:30:00Z'));
    track.evaluateTracked({ BTC: { price: 4360000 } }, []);
    rec = track.getTrackRecord(1);
    expect(rec.openCount).toBe(1);

    // Past UTC midnight (IST Sunday 06:00 = UTC 00:30) → stale row reconciles.
    vi.setSystemTime(new Date('2026-08-30T00:30:00Z'));
    track.reconcileStale([]);
    rec = track.getTrackRecord(1);
    expect(rec.openCount).toBe(0);
    expect(rec.history[0].status).toBe('EOD_EXIT');
    expect(rec.history[0].market).toBe('CRYPTO');
  });
});
