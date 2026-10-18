// ============================================================
// intraday/movers — Trending Gainers/Losers deep-analysis engine
// ------------------------------------------------------------
// Powers GET /api/intraday-movers?market=INDIA|CRYPTO:
//   • top gainers / top losers across the ACTIVE scanner universe
//     (custom watchlist included — effectiveUniverse)
//   • MOST ACTIVE by session volume (2026-09 v4.5)
//   • market breadth (advances / declines / unchanged, avg move)
//   • SECTOR pulse — per-sector avg move + advancing/declining
//     counts from the same rows (2026-09 v4.5)
//   • CRYPTO index pulse (BTC / ETH majors off the same batch)
//   • PER-ROW deep analysis computed from the SAME indicator
//     snapshot the scanner already fetches (TradingView batch:
//     RSI / VWAP / SMA50 / EMA20 / ADX / relative-volume / pivots
//     + Groww/CoinDCX live LTP) — zero extra upstream cost, zero
//     AI tokens, fully deterministic.
// Pure functions only (buildMoversRows / moversAnalysis /
// buildSectorPulse / buildCryptoIndices) so the vitest suite can
// cover the math without network mocks.
// ============================================================

import { paceRelVolume } from './time.js';

const MOVERS_TOP_N = 8;

/** Round to 2dp, null-safe. */
const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ------------------------------------------------------------
// SECTOR map (server mirror of src/components/intraday/sectorMap.ts —
// kept in sync manually; unmapped symbols fall back to 'Other').
// Powers the sector-pulse aggregation in the movers payload.
// ------------------------------------------------------------
const SECTOR_MAP = {
  // Banks & Financials
  HDFCBANK: 'Banks', ICICIBANK: 'Banks', SBIN: 'Banks', KOTAKBANK: 'Banks',
  AXISBANK: 'Banks', INDUSINDBK: 'Banks', BANKBARODA: 'Banks', UNIONBANK: 'Banks',
  FEDERALBNK: 'Banks', IDFCFIRSTB: 'Banks', AUBANK: 'Banks', CANBK: 'Banks',
  PNB: 'Banks', YESBANK: 'Banks',
  SBILIFE: 'Insurance', HDFCLIFE: 'Insurance', ICICIPRULI: 'Insurance', LICI: 'Insurance',
  BAJFINANCE: 'NBFC', BAJAJFINSV: 'NBFC', SHRIRAMFIN: 'NBFC', CHOLAFIN: 'NBFC',
  JIOFIN: 'Fintech', PAYTM: 'Fintech', POLICYBZR: 'Fintech',
  // IT
  INFY: 'IT', TCS: 'IT', WIPRO: 'IT', HCLTECH: 'IT', TECHM: 'IT',
  LTIM: 'IT', COFORGE: 'IT', MPHASIS: 'IT', PERSISTENT: 'IT', TATAELXSI: 'IT',
  // Oil, Gas & Power
  ONGC: 'Oil & Gas', BPCL: 'Oil & Gas', IOC: 'Oil & Gas', GAIL: 'Oil & Gas',
  PETRONET: 'Oil & Gas', COALINDIA: 'Mining', NTPC: 'Power', POWERGRID: 'Power',
  TATAPOWER: 'Power', ADANIGREEN: 'Power', ADANIPOWER: 'Power', IREDA: 'Power',
  SUZLON: 'Power',
  // Metals & Mining
  TATASTEEL: 'Metals', JSWSTEEL: 'Metals', HINDALCO: 'Metals', VEDL: 'Metals',
  // FMCG & Consumer
  ITC: 'FMCG', HINDUNILVR: 'FMCG', BRITANNIA: 'FMCG', TITAN: 'Consumer',
  TRENT: 'Consumer', ZOMATO: 'Consumer Tech', NYKAA: 'Consumer Tech',
  // Pharma & Healthcare
  SUNPHARMA: 'Pharma', CIPLA: 'Pharma', DRREDDY: 'Pharma', DIVISLAB: 'Pharma',
  LUPIN: 'Pharma', AUROPHARMA: 'Pharma', APOLLOHOSP: 'Healthcare',
  // Auto
  MARUTI: 'Auto', TATAMOTORS: 'Auto', EICHERMOT: 'Auto', HEROMOTOCO: 'Auto', 'M&M': 'Auto',
  // Infra, Cement & Realty
  LT: 'Infra', ULTRACEMCO: 'Cement', GRASIM: 'Cement', ADANIENT: 'Infra',
  ADANIPORTS: 'Infra', DLF: 'Realty', IRFC: 'Infra', BEL: 'Defense', HAL: 'Defense',
  // Telecom
  BHARTIARTL: 'Telecom', IDEA: 'Telecom',
  // Chemicals & Materials
  ASIANPAINT: 'Chemicals', PIDILITIND: 'Chemicals', HAVELLS: 'Consumer Durables',
  // Conglomerate
  RELIANCE: 'Conglomerate',
  // CRYPTO sub-sectors
  BTC: 'Layer 1', ETH: 'Layer 1', SOL: 'Layer 1', ADA: 'Layer 1',
  AVAX: 'Layer 1', DOT: 'Layer 1', MATIC: 'Layer 2',
  BNB: 'Exchange', UNI: 'DeFi', LINK: 'DeFi',
  XRP: 'Payments', DOGE: 'Meme',
};

const sectorOf = (sym) => SECTOR_MAP[String(sym || '').trim().toUpperCase()] || 'Other';

/**
 * PURE: aggregate rows into a sector pulse list —
 * [{ name, count, advancing, declining, avgPct }] sorted strongest-first.
 */
export function buildSectorPulse(rows) {
  const bySector = {};
  for (const r of rows || []) {
    const sec = sectorOf(r.symbol);
    if (!bySector[sec]) bySector[sec] = { name: sec, count: 0, sum: 0, advancing: 0, declining: 0 };
    const g = bySector[sec];
    g.count += 1;
    g.sum += (r.changePct ?? 0);
    if ((r.changePct ?? 0) > 0) g.advancing += 1;
    else if ((r.changePct ?? 0) < 0) g.declining += 1;
  }
  return Object.values(bySector)
    .map(g => ({ name: g.name, count: g.count, advancing: g.advancing, declining: g.declining, avgPct: r2(g.sum / g.count) ?? 0 }))
    .sort((a, b) => b.avgPct - a.avgPct);
}

/**
 * PURE: crypto "index pulse" — BTC/ETH majors off the same batch rows
 * (universe rows keyed by base symbol). Returns [] when a major is absent.
 */
export function buildCryptoIndices(rows) {
  const bySym = {};
  for (const r of rows || []) bySym[String(r.symbol).toUpperCase()] = r;
  return ['BTC', 'ETH']
    .filter(s => bySym[s])
    .map(s => ({
      symbol: s, name: s === 'BTC' ? 'Bitcoin' : 'Ethereum',
      ltp: bySym[s].ltp, changePct: bySym[s].changePct,
      vwapDist: bySym[s].vwapDist ?? null, rsi: bySym[s].rsi ?? null,
    }));
}

// ------------------------------------------------------------

/**
 * One mover row + its deep-analysis verdict.
 * tv: TradingView indicator row (may be null — quote-only fallback)
 * q:  live quote { price, change, high, low, volume } (Groww NSE / CoinDCX INR)
 */
export function moversAnalysis(row, _market) {
  const tags = [];
  const bits = [];

  // --- VWAP side (intraday strength oracle) ---
  if (row.vwap != null && row.ltp > 0) {
    const vwapDist = (row.ltp - row.vwap) / row.vwap * 100;
    row.vwapDist = r2(vwapDist);
    if (vwapDist > 0.3) { tags.push('VWAP+'); bits.push(`VWAP ke upar +${vwapDist.toFixed(1)}%`); }
    else if (vwapDist < -0.3) { tags.push('VWAP−'); bits.push(`VWAP ke neeche ${vwapDist.toFixed(1)}%`); }
    else bits.push('VWAP par chipka hua');
  }

  // --- RSI zone ---
  if (row.rsi != null) {
    if (row.rsi >= 70) { tags.push('RSI-OB'); bits.push(`RSI ${row.rsi.toFixed(0)} overbought — pullback risk`); }
    else if (row.rsi <= 30) { tags.push('RSI-OS'); bits.push(`RSI ${row.rsi.toFixed(0)} oversold — bounce zone`); }
    else if (row.rsi >= 55) bits.push(`RSI ${row.rsi.toFixed(0)} bullish momentum`);
    else if (row.rsi <= 45) bits.push(`RSI ${row.rsi.toFixed(0)} bearish momentum`);
    else bits.push(`RSI ${row.rsi.toFixed(0)} neutral`);
  }

  // --- Volume surge (relative volume vs 10d average) ---
  if (row.relVolume != null) {
    if (row.relVolume >= 2.5) { tags.push('VOL-SURGE'); bits.push(`volume ${row.relVolume.toFixed(1)}x — institutional participation`); }
    else if (row.relVolume >= 1.5) { tags.push('VOL↑'); bits.push(`volume ${row.relVolume.toFixed(1)}x average`); }
    else if (row.relVolume < 0.7) bits.push(`volume patla ${row.relVolume.toFixed(1)}x — move ki reliability kam`);
  }

  // --- Trend structure (price vs SMA50 / EMA20) ---
  if (row.sma50 != null && row.ltp > 0) {
    if (row.ltp > row.sma50 * 1.01) { tags.push('ABOVE-SMA50'); bits.push('din ke high side me trend up'); }
    else if (row.ltp < row.sma50 * 0.99) { tags.push('BELOW-SMA50'); bits.push('trend weak — neeche side'); }
  }
  if (row.ema20 != null && row.sma50 != null) {
    if (row.ema20 > row.sma50) tags.push('EMA20>SMA50');
    else tags.push('EMA20<SMA50');
  }

  // --- ADX trend strength ---
  if (row.adx != null) {
    if (row.adx >= 25) { tags.push('STRONG-TREND'); bits.push(`ADX ${row.adx.toFixed(0)} — strong trend, trail-friendly`); }
    else if (row.adx < 15) bits.push(`ADX ${row.adx.toFixed(0)} — sideways/choppy, breakout wait karo`);
  }

  // --- Pivot room (how far to the classic pivot levels) ---
  if (row.pivotR1 != null && row.ltp > 0 && row.pivotR1 > row.ltp) {
    row.pivotRoomUp = r2((row.pivotR1 - row.ltp) / row.ltp * 100);
  }
  if (row.pivotS1 != null && row.ltp > 0 && row.pivotS1 < row.ltp) {
    row.pivotRoomDown = r2((row.ltp - row.pivotS1) / row.ltp * 100);
  }

  // --- Day-range position (where in the L..H band is the price) ---
  // v20.9.1 [L]: ltp-missing guard — undefined arithmetic NaN position
  // deta tha (Math.max(0, Math.min(100, NaN)) = NaN) aur NaN tags/bits
  // skip hote the par dayRangePos NaN UI tak ja sakta tha.
  if (row.high != null && row.low != null && row.high > row.low && row.ltp != null) {
    const pos = Math.max(0, Math.min(100, (row.ltp - row.low) / (row.high - row.low) * 100));
    row.dayRangePos = Math.round(pos);
    if (pos >= 85) { tags.push('AT-HIGH'); bits.push('day high ke paas — breakout watch'); }
    else if (pos <= 15) { tags.push('AT-LOW'); bits.push('day low ke paas — breakdown watch'); }
  }

  row.tags = tags;
  // Hinglish one-line deep verdict (kept compact for the mover list UI).
  row.analysis = bits.slice(0, 3).join(' • ') || 'indicators mixed — quote-only row';
  return row;
}

/**
 * PURE: build the full movers payload from a fetched batch.
 * universe: effective scanner symbols
 * tvData / quoteData: outputs of fetchIntradayDataBatch (same shapes
 *   the scanner uses — INDIA: TV indicators + Groww quotes; CRYPTO:
 *   TV(INR-rescaled) + CoinDCX INR quotes)
 */
export function buildMoversRows(universe, tvData, quoteData, market = 'INDIA', date = new Date()) {
  const isCrypto = String(market).toUpperCase() === 'CRYPTO';
  const rows = [];
  for (const sym of universe || []) {
    const tv = tvData?.[sym] || null;
    const q = quoteData?.[sym] || null;
    const ltp = (q && q.price > 0) ? q.price : (tv && (tv.last > 0 ? tv.last : tv.close > 0 ? tv.close : 0)) || 0;
    if (!ltp) continue;
    // Day change % — prefer the LIVE quote (Groww day % / CoinDCX 24h %),
    // fall back to the TV batch value.
    const changePct = (q && typeof q.change === 'number' && Number.isFinite(q.change) && q.change !== 0)
      ? q.change
      : (tv && typeof tv.change === 'number' && Number.isFinite(tv.change) ? tv.change : 0);
    const row = {
      symbol: sym,
      market: isCrypto ? 'CRYPTO' : 'INDIA',
      ltp: r2(ltp),
      changePct: r2(changePct) ?? 0,
      high: (q && q.high > 0) ? r2(q.high) : (tv ? r2(tv.high) : null),
      low: (q && q.low > 0) ? r2(q.low) : (tv ? r2(tv.low) : null),
      volume: (q && q.volume > 0) ? q.volume : (tv ? tv.volume : null),
      // SESSION-PACE relVol (2026-09 audit fix — same as engine.js):
      // TV raw relVol is cumulative vs FULL-DAY avg, so mornings read
      // 0.1–0.4 across the board. Pace = raw ÷ expected session share →
      // the VOL× chips and thin-volume verdicts mean "vs avg daily
      // pace at this time". Post-close/weekend → pace == raw. Crypto raw.
      relVolume: (tv && typeof tv.relVolume === 'number' && tv.relVolume > 0)
        ? r2(paceRelVolume(tv.relVolume, market, date) ?? tv.relVolume)
        : (tv ? r2(tv.relVolume) : null),
      rsi: tv ? r2(tv.rsi) : null,
      adx: tv ? r2(tv.adx) : null,
      vwap: tv ? r2(tv.vwap) : null,
      sma50: tv ? r2(tv.sma50) : null,
      ema20: tv ? r2(tv.ema20) : null,
      pivotR1: tv ? r2(tv.pivotR1) : null,
      pivotS1: tv ? r2(tv.pivotS1) : null,
      vwapDist: null, dayRangePos: null, pivotRoomUp: null, pivotRoomDown: null,
      tags: [], analysis: '',
    };
    rows.push(moversAnalysis(row, market));
  }

  rows.sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
  const gainers = rows.filter(r => (r.changePct ?? 0) > 0).slice(0, MOVERS_TOP_N);
  const losers = rows.filter(r => (r.changePct ?? 0) < 0).slice(-MOVERS_TOP_N).reverse();

  // MOST ACTIVE — session-volume leaders (v4.5). Only rows that actually
  // reported volume; strongest first. Volume for crypto = CoinDCX INR
  // notional-ish (quote volume), for NSE = share count — both rank fine.
  const mostActive = rows
    .filter(r => (r.volume ?? 0) > 0)
    .slice()
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, MOVERS_TOP_N);

  // SECTOR pulse + CRYPTO index pulse (v4.5) — same rows, zero extra fetch.
  const sectors = buildSectorPulse(rows);
  const indices = isCrypto ? buildCryptoIndices(rows) : [];

  const advanced = rows.filter(r => (r.changePct ?? 0) > 0).length;
  const declined = rows.filter(r => (r.changePct ?? 0) < 0).length;
  const unchanged = rows.length - advanced - declined;
  const avgChange = rows.length ? rows.reduce((s, r) => s + (r.changePct ?? 0), 0) / rows.length : 0;

  return {
    gainers,
    losers,
    mostActive,
    sectors,
    indices,
    breadth: {
      scanned: rows.length,
      advanced,
      declined,
      unchanged,
      avgChangePct: r2(avgChange) ?? 0,
      advanceDeclineRatio: declined > 0 ? r2(advanced / declined) : (advanced > 0 ? null : 0),
      // Regime read from pure breadth (matches desk language).
      bias: advanced > declined * 1.5 ? 'BULLISH' : declined > advanced * 1.5 ? 'BEARISH' : 'MIXED',
    },
  };
}
