// ============================================
// MARKET DATA ENGINE — TradingView + Yahoo + Forex
// ============================================

import { EXACT_TICKER_MAP, guessMarket, DEFAULT_USD_INR } from './config.mjs';

// ========================================
// MARKET HOURS DETECTION
// ========================================
// FIX H17: previously `new Date(now.toLocaleString('en-US', { timeZone: ... }))`
// relied on the en-US locale producing a Date-parseable string. On non-English
// servers or with different ICU builds, `new Date(string)` may return Invalid
// Date → getDay() returns NaN → market hours never detected. Use
// Intl.DateTimeFormat.formatToParts for robust parsing.
function getTimeInZone(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[get('weekday').substring(0, 3)] ?? now.getDay();
  let h = parseInt(get('hour'), 10);
  if (isNaN(h) || h === 24) h = 0;
  const m = parseInt(get('minute'), 10) || 0;
  return { day, h, m };
}

export function isIndiaMarketOpen() {
  const { day, h, m } = getTimeInZone('Asia/Kolkata');
  if (day === 0 || day === 6) return false;
  const mins = h * 60 + m;
  return mins >= 555 && mins <= 930; // 9:15 AM - 3:30 PM IST
}

export function isUSMarketOpen() {
  const { day, h, m } = getTimeInZone('America/New_York');
  if (day === 0 || day === 6) return false;
  const mins = h * 60 + m;
  return mins >= 570 && mins <= 960; // 9:30 AM - 4:00 PM ET
}

export function isAnyMarketOpen() {
  return isIndiaMarketOpen() || isUSMarketOpen();
}

export function getMarketStatus() {
  const inOpen = isIndiaMarketOpen();
  const usOpen = isUSMarketOpen();
  if (inOpen && usOpen) return '🇮🇳 IN + 🇺🇸 US Markets LIVE';
  if (inOpen) return '🇮🇳 India Market LIVE';
  if (usOpen) return '🇺🇸 US Market LIVE';
  return '💤 Markets Closed';
}

export function getISTTime() {
  return new Date().toLocaleTimeString('en-IN', { 
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// ========================================
// BATCH FETCH PRICES (TradingView Scanner)
// ========================================
export async function batchFetchPrices(positions) {
  const livePrices = {};
  const inTickers = [];
  const usTickers = [];
  const tickerToKey = {};
  // v20.9.1 [H3]: crypto holdings ka apna batch — EXACT_TICKER_MAP ki
  // BINANCE:* entries pehle mkt==='IN' (config.mjs isCryptoSymbol→'IN')
  // ki wajah se INDIA scanner endpoint pe jaati thi, jo BINANCE symbols
  // KABHI return nahi karta → livePrices['IN_BTC'] hamesha missing →
  // /portfolio, /pnl aur superintelligence tool avgPrice pe fall back
  // karte the (frozen P&L). Ab crypto scanner endpoint apna batch hai.
  const cryptoTickers = [];

  for (const p of positions) {
    if (!p?.symbol) continue;
    const mkt = (p.market || guessMarket(p.symbol)).toUpperCase();
    const key = `${mkt}_${p.symbol.trim()}`;
    const cleanSym = p.symbol.replace('.NS', '').replace('.BO', '').trim();

    if (EXACT_TICKER_MAP[cleanSym]) {
      const t = EXACT_TICKER_MAP[cleanSym];
      if (/^(BINANCE|CRYPTOCAP|COINBASE|KRAKEN|BYBIT):/i.test(t)) cryptoTickers.push(t);
      else if (mkt === 'IN') inTickers.push(t); else usTickers.push(t);
      tickerToKey[t] = key;
    } else if (mkt === 'IN') {
      inTickers.push(`NSE:${cleanSym}`, `BSE:${cleanSym}`);
      tickerToKey[`NSE:${cleanSym}`] = key;
      tickerToKey[`BSE:${cleanSym}`] = key;
    } else {
      usTickers.push(`NASDAQ:${cleanSym}`, `NYSE:${cleanSym}`, `AMEX:${cleanSym}`);
      tickerToKey[`NASDAQ:${cleanSym}`] = key;
      tickerToKey[`NYSE:${cleanSym}`] = key;
      tickerToKey[`AMEX:${cleanSym}`] = key;
    }
  }

  // Add VIX indices
  inTickers.push('NSE:INDIAVIX');
  tickerToKey['NSE:INDIAVIX'] = 'IN_INDIAVIX';
  usTickers.push('CBOE:VIX');
  tickerToKey['CBOE:VIX'] = 'US_VIX';

  const scanBatch = async (endpoint, tickers) => {
    if (tickers.length === 0) return;
    const uniqueTickers = [...new Set(tickers)];
    try {
      const res = await fetch(`https://scanner.tradingview.com/${endpoint}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          symbols: { tickers: uniqueTickers },
          columns: ['name', 'close', 'change', 'high', 'low', 'volume', 'SMA20', 'SMA50', 'RSI', 'MACD.macd']
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.data) {
          for (const item of data.data) {
            if (!item.d || item.d[1] === null) continue;
            const priceVal = parseFloat(item.d[1]);
            if (isNaN(priceVal) || priceVal <= 0) continue;
            const key = tickerToKey[item.s];
            if (!key) continue;
            const changeVal = parseFloat(item.d[2]) || 0;
            const mkt = key.split('_')[0];
            livePrices[key] = {
              price: priceVal,
              change: changeVal,
              high: parseFloat(item.d[3]) || priceVal,
              low: parseFloat(item.d[4]) || priceVal,
              volume: parseFloat(item.d[5]) || 0,
              // FIX H12: `parseFloat(x) || fallback` swallows legitimate 0 values
              // (SMA20=0, MACD=0.0, RSI=0). Use nullish coalescing where the
              // fallback is non-numeric (`undefined`).
              sma20: (item.d[6] != null && !isNaN(parseFloat(item.d[6]))) ? parseFloat(item.d[6]) : undefined,
              sma50: (item.d[7] != null && !isNaN(parseFloat(item.d[7]))) ? parseFloat(item.d[7]) : undefined,
              rsi: (item.d[8] != null && !isNaN(parseFloat(item.d[8]))) ? parseFloat(item.d[8]) : Math.max(10, Math.min(90, 50 + (changeVal * 5))),
              macd: (item.d[9] != null && !isNaN(parseFloat(item.d[9]))) ? parseFloat(item.d[9]) : undefined,
              time: Date.now(),
              market: mkt,
              tvExchange: item.s.split(':')[0],
              tvExactSymbol: item.s
            };
          }
        }
      }
    } catch (e) {
      console.warn(`⚠️ TradingView ${endpoint} scan failed:`, e.message);
    }
  };

  await Promise.allSettled([
    scanBatch('india', inTickers),
    scanBatch('america', usTickers),
    // v20.9.1 [H3]: crypto batch — TradingView ka crypto scanner endpoint
    scanBatch('crypto', cryptoTickers)
  ]);

  return livePrices;
}

// ========================================
// SINGLE SYMBOL SCAN (for /scan command)
// ========================================
export async function fetchSingleSymbol(symbol) {
  const cleanSym = symbol.replace('.NS', '').replace('.BO', '').trim().toUpperCase();
  const mkt = guessMarket(cleanSym);

  // Try multiple exchanges — build a comprehensive ticker list
  let tickers;
  if (EXACT_TICKER_MAP[cleanSym]) {
    tickers = [EXACT_TICKER_MAP[cleanSym]];
  } else if (mkt === 'IN') {
    tickers = [`NSE:${cleanSym}`, `BSE:${cleanSym}`];
  } else {
    // FIX: try ALL US exchanges + Yahoo fallback
    tickers = [`NASDAQ:${cleanSym}`, `NYSE:${cleanSym}`, `AMEX:${cleanSym}`];
  }

  // v20.9.1 [H3]: crypto single-symbol bhi crypto endpoint pe — pehle
  // mkt==='IN' (crypto classification) india scanner pe jaata tha jahan
  // BINANCE:* kabhi match nahi hota tha (Yahoo fallback .NS bhi galat).
  const isCryptoTicker = /^(BINANCE|CRYPTOCAP|COINBASE|KRAKEN|BYBIT):/i.test(tickers[0] || '');
  const endpoint = isCryptoTicker ? 'crypto' : (mkt === 'IN' ? 'india' : 'america');
  try {
    const res = await fetch(`https://scanner.tradingview.com/${endpoint}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        symbols: { tickers },
        columns: ['name', 'close', 'change', 'high', 'low', 'volume', 'SMA20', 'SMA50', 'RSI', 'MACD.macd', 'open', 'Perf.W', 'Perf.1M', 'Perf.3M']
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.data?.[0]?.d) {
        const d = data.data[0].d;
        const price = parseFloat(d[1]);
        if (isNaN(price) || price <= 0) return null;
        return {
          symbol: cleanSym,
          name: d[0] || cleanSym,
          market: mkt,
          price,
          change: parseFloat(d[2]) || 0,
          high: parseFloat(d[3]) || price,
          low: parseFloat(d[4]) || price,
          volume: parseFloat(d[5]) || 0,
          sma20: (d[6] != null && !isNaN(parseFloat(d[6]))) ? parseFloat(d[6]) : undefined,
          sma50: (d[7] != null && !isNaN(parseFloat(d[7]))) ? parseFloat(d[7]) : undefined,
          rsi: (d[8] != null && !isNaN(parseFloat(d[8]))) ? parseFloat(d[8]) : 50,
          macd: (d[9] != null && !isNaN(parseFloat(d[9]))) ? parseFloat(d[9]) : undefined,
          open: parseFloat(d[10]) || price,
          weekChange: parseFloat(d[11]) || 0,
          monthChange: parseFloat(d[12]) || 0,
          threeMonthChange: parseFloat(d[13]) || 0,
          tvSymbol: data.data[0].s,
          time: Date.now()
        };
      }
    }
  } catch (e) {
    console.warn(`Single symbol fetch failed for ${cleanSym}:`, e.message);
  }

  // FIX: Yahoo Finance fallback for symbols TradingView can't find (SPCX, etc.)
  try {
    const ysym = mkt === 'IN' ? `${cleanSym}.NS` : cleanSym;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=1d&range=5d`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI scan proxy)' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (meta && typeof meta.regularMarketPrice === 'number' && meta.regularMarketPrice > 0) {
        const price = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose || meta.previousClose || price;
        const change = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
        return {
          symbol: cleanSym,
          name: cleanSym,
          market: mkt,
          price,
          change,
          high: meta.regularMarketDayHigh || price,
          low: meta.regularMarketDayLow || price,
          volume: meta.regularMarketVolume || 0,
          rsi: 50,
          time: Date.now(),
          tvSymbol: ysym,
          source: 'yahoo-fallback',
        };
      }
    }
  } catch (e) {
    console.warn(`Yahoo fallback failed for ${cleanSym}:`, e.message);
  }

  return null;
}

// ========================================
// VIX CHANGE TRACKING (for spike detection)
// ========================================
let lastVixSnapshot = { usVix: 0, inVix: 0, time: 0 };

export function trackVixChange(livePrices) {
  const usVix = livePrices['US_VIX']?.price || 0;
  const inVix = livePrices['IN_INDIAVIX']?.price || 0;
  const now = Date.now();

  // FIX CRIT: previously when TV returned no VIX (usVix=0 OR inVix=0), the
  // snapshot was still overwritten with zeros, so subsequent calls saw
  // lastVixSnapshot.usVix=0 and the `lastVixSnapshot.usVix > 0` check (line 219)
  // short-circuited → spike detection permanently disabled after one transient
  // fetch failure. Skip the snapshot update entirely when either VIX is missing.
  if (lastVixSnapshot.time === 0 || usVix === 0 || inVix === 0) {
    if (usVix > 0 && inVix > 0) {
      // First valid reading — record it but don't alert yet.
      lastVixSnapshot = { usVix, inVix, time: now };
    }
    return null;
  }

  const elapsed = (now - lastVixSnapshot.time) / 60000; // minutes
  if (elapsed < 5) return null; // Check every 5 min minimum

  const usChange = lastVixSnapshot.usVix > 0 ? ((usVix - lastVixSnapshot.usVix) / lastVixSnapshot.usVix) * 100 : 0;
  const inChange = lastVixSnapshot.inVix > 0 ? ((inVix - lastVixSnapshot.inVix) / lastVixSnapshot.inVix) * 100 : 0;

  // Only update snapshot when both VIX values are valid (non-zero).
  if (usVix > 0 && inVix > 0) {
    lastVixSnapshot = { usVix, inVix, time: now };
  }

  // Alert if VIX jumps > 5% in short period
  if (Math.abs(usChange) > 5 || Math.abs(inChange) > 5) {
    return {
      usVix, inVix, usChange, inChange,
      severity: Math.max(Math.abs(usChange), Math.abs(inChange)) > 10 ? 'EXTREME' : 'HIGH'
    };
  }
  return null;
}

// ========================================
// FOREX RATE — USD/INR
// ========================================
export async function fetchForexRate() {
  // Method 1: Yahoo Finance (direct — no CORS needed on server)
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/INR=X?interval=1d&range=1d', {
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) {
      const data = await res.json();
      const price = parseFloat(data?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (!isNaN(price) && price > 50 && price < 150) return price;
    }
  } catch (e) {}

  // Method 2: AwesomeAPI
  try {
    const res = await fetch(`https://economia.awesomeapi.com.br/json/last/USD-INR?t=${Date.now()}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.USDINR?.ask) {
        const price = parseFloat(data.USDINR.ask);
        if (!isNaN(price) && price > 50 && price < 150) return price;
      }
    }
  } catch (e) {}

  // Method 3: Open ER-API
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/USD?t=${Date.now()}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.rates?.INR) {
        const price = parseFloat(data.rates.INR);
        if (!isNaN(price) && price > 50 && price < 150) return price;
      }
    }
  } catch (e) {}

  return DEFAULT_USD_INR; // Default
}

// ========================================
// MARKET INTELLIGENCE — Global Indices + Sectors
// ========================================
export async function fetchMarketIntelligence() {
  const intelligence = {
    globalIndices: [],
    sectors: [],
    fearGreedScore: 50,
    marketNarrative: '',
    keyLevels: { nifty: 0, sensex: 0, spy: 0, qqq: 0 },
    timestamp: Date.now()
  };

  try {
    const indexTickers = [
      'NSE:NIFTY', 'BSE:SENSEX', 'NSE:BANKNIFTY',
      'AMEX:SPY', 'NASDAQ:QQQ', 'AMEX:DIA', 'AMEX:IWM',
      'TVC:DXY', 'COMEX:GC1!', 'NYMEX:CL1!',
      'CBOE:VIX', 'NSE:INDIAVIX'
    ];
    const sectorTickers = [
      'AMEX:XLK', 'AMEX:XLF', 'AMEX:XLE', 'AMEX:XLV', 'AMEX:XLI',
      'NSE:CNXIT', 'NSE:CNXFIN', 'NSE:CNXPHARMA'
    ];

    const nameMap = {
      'NSE:NIFTY': 'NIFTY 50', 'BSE:SENSEX': 'SENSEX', 'NSE:BANKNIFTY': 'BANK NIFTY',
      'AMEX:SPY': 'S&P 500', 'NASDAQ:QQQ': 'NASDAQ 100', 'AMEX:DIA': 'DOW JONES',
      'AMEX:IWM': 'RUSSELL 2000', 'TVC:DXY': 'US DOLLAR', 'COMEX:GC1!': 'GOLD',
      'NYMEX:CL1!': 'CRUDE OIL', 'CBOE:VIX': 'VIX', 'NSE:INDIAVIX': 'INDIA VIX'
    };
    const sectorNameMap = {
      'AMEX:XLK': 'US Tech', 'AMEX:XLF': 'US Finance', 'AMEX:XLE': 'US Energy',
      'AMEX:XLV': 'US Healthcare', 'AMEX:XLI': 'US Industrial',
      'NSE:CNXIT': 'IN IT', 'NSE:CNXFIN': 'IN Finance', 'NSE:CNXPHARMA': 'IN Pharma'
    };

    const [indexRes, sectorRes] = await Promise.allSettled([
      fetch('https://scanner.tradingview.com/global/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ symbols: { tickers: indexTickers }, columns: ['name', 'close', 'change'] }),
        signal: AbortSignal.timeout(8000)
      }),
      fetch('https://scanner.tradingview.com/global/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ symbols: { tickers: sectorTickers }, columns: ['name', 'close', 'change'] }),
        signal: AbortSignal.timeout(8000)
      })
    ]);

    if (indexRes.status === 'fulfilled' && indexRes.value.ok) {
      const data = await indexRes.value.json();
      if (data?.data) {
        for (const item of data.data) {
          if (item.d && item.d[1] !== null) {
            intelligence.globalIndices.push({
              name: nameMap[item.s] || item.d[0],
              price: parseFloat(item.d[1]) || 0,
              change: parseFloat(item.d[2]) || 0
            });
            if (item.s === 'NSE:NIFTY') intelligence.keyLevels.nifty = parseFloat(item.d[1]) || 0;
            if (item.s === 'BSE:SENSEX') intelligence.keyLevels.sensex = parseFloat(item.d[1]) || 0;
            if (item.s === 'AMEX:SPY') intelligence.keyLevels.spy = parseFloat(item.d[1]) || 0;
            if (item.s === 'NASDAQ:QQQ') intelligence.keyLevels.qqq = parseFloat(item.d[1]) || 0;
          }
        }
      }
    }

    if (sectorRes.status === 'fulfilled' && sectorRes.value.ok) {
      const data = await sectorRes.value.json();
      if (data?.data) {
        for (const item of data.data) {
          if (item.d && item.d[2] !== null) {
            intelligence.sectors.push({
              name: sectorNameMap[item.s] || item.d[0],
              change: parseFloat(item.d[2]) || 0
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('Market intelligence fetch failure:', e.message);
  }

  // Fear/Greed from VIX
  const vix = intelligence.globalIndices.find(i => i.name === 'VIX');
  const inVix = intelligence.globalIndices.find(i => i.name === 'INDIA VIX');
  const avgVix = ((vix?.price || 15) + (inVix?.price || 15)) / 2;
  if (avgVix > 30) intelligence.fearGreedScore = 10;
  else if (avgVix > 25) intelligence.fearGreedScore = 20;
  else if (avgVix > 20) intelligence.fearGreedScore = 35;
  else if (avgVix > 16) intelligence.fearGreedScore = 50;
  else if (avgVix > 12) intelligence.fearGreedScore = 70;
  else intelligence.fearGreedScore = 85;

  // Build narrative
  const bullSectors = intelligence.sectors.filter(s => s.change > 1).map(s => s.name);
  const bearSectors = intelligence.sectors.filter(s => s.change < -1).map(s => s.name);
  const niftyMove = intelligence.globalIndices.find(i => i.name === 'NIFTY 50')?.change || 0;
  const spyMove = intelligence.globalIndices.find(i => i.name === 'S&P 500')?.change || 0;

  let narrative = '';
  if (avgVix > 25) narrative = `🔴 FEAR DOMINANT — VIX at ${avgVix.toFixed(1)}. Institutional hedging active. Cash is king.`;
  else if (avgVix > 18) narrative = `🟡 CAUTIOUS — Elevated volatility (VIX ${avgVix.toFixed(1)}). Mixed signals.`;
  else if (avgVix < 13) narrative = `⚠️ EXTREME GREED — VIX ultra-low at ${avgVix.toFixed(1)}. Complacency high.`;
  else narrative = `🟢 NEUTRAL-BULLISH — VIX steady at ${avgVix.toFixed(1)}. SIP mode optimal.`;

  if (niftyMove > 1.5 || spyMove > 1.5) narrative += ` Strong rally (NIFTY ${niftyMove > 0 ? '+' : ''}${niftyMove.toFixed(1)}%, SPY ${spyMove > 0 ? '+' : ''}${spyMove.toFixed(1)}%).`;
  else if (niftyMove < -1.5 || spyMove < -1.5) narrative += ` Selloff (NIFTY ${niftyMove.toFixed(1)}%, SPY ${spyMove.toFixed(1)}%). Look for value.`;

  if (bullSectors.length > 0) narrative += ` 📈 Leading: ${bullSectors.join(', ')}.`;
  if (bearSectors.length > 0) narrative += ` 📉 Lagging: ${bearSectors.join(', ')}.`;

  intelligence.marketNarrative = narrative;
  return intelligence;
}

// ========================================
// CRYPTO PRICES (CoinDCX — Primary INR Source)
// ========================================
export async function fetchCryptoPricesINR() {
  try {
    const res = await fetch(`https://api.coindcx.com/exchange/ticker`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const tickers = await res.json();
    const nameMap = { 'BTCINR': 'BTC', 'ETHINR': 'ETH', 'SOLINR': 'SOL', 'XRPINR': 'XRP', 'BNBINR': 'BNB', 'ADAINR': 'ADA', 'DOGEINR': 'DOGE', 'DOTINR': 'DOT' };
    return tickers
      .filter(t => nameMap[t.market])
      .map(t => ({
        symbol: nameMap[t.market] || t.market,
        name: nameMap[t.market] === 'BTC' ? 'Bitcoin' : nameMap[t.market] === 'ETH' ? 'Ethereum' : nameMap[t.market],
        price: parseFloat(t.last_price) || 0,
        change: parseFloat(t.change_24_hour) || 0,
        high: parseFloat(t.high) || 0,
        low: parseFloat(t.low) || 0,
        volume: parseFloat(t.volume) || 0,
        marketCap: 0,
        source: 'COINDCX'
      }))
      .filter(c => c.price > 0);
  } catch (e) {
    console.warn('CoinDCX crypto fetch failed:', e.message);
    return [];
  }
}

// ========================================
// CRYPTO PRICES (TradingView — USD fallback)
// ========================================
export async function fetchCryptoPrices() {
  try {
    const tickers = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT', 'BINANCE:XRPUSDT', 'BINANCE:BNBUSDT', 'BINANCE:ADAUSDT', 'BINANCE:DOGEUSDT', 'BINANCE:DOTUSDT'];
    const res = await fetch('https://scanner.tradingview.com/crypto/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ symbols: { tickers }, columns: ['description', 'close', 'change', 'volume', 'market_cap_basic', 'high', 'low'] }),
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const nameMap = { 'BINANCE:BTCUSDT': 'BTC', 'BINANCE:ETHUSDT': 'ETH', 'BINANCE:SOLUSDT': 'SOL', 'BINANCE:XRPUSDT': 'XRP', 'BINANCE:BNBUSDT': 'BNB', 'BINANCE:ADAUSDT': 'ADA', 'BINANCE:DOGEUSDT': 'DOGE', 'BINANCE:DOTUSDT': 'DOT' };
    return (data?.data || []).map(item => ({
      symbol: nameMap[item.s] || item.s,
      name: item.d?.[0] || '',
      price: parseFloat(item.d?.[1]) || 0,
      change: parseFloat(item.d?.[2]) || 0,
      volume: parseFloat(item.d?.[3]) || 0,
      marketCap: parseFloat(item.d?.[4]) || 0,
      high: parseFloat(item.d?.[5]) || 0,
      low: parseFloat(item.d?.[6]) || 0
    })).filter(c => c.price > 0);
  } catch (e) {
    console.warn('Crypto fetch failed:', e.message);
    return [];
  }
}

// ========================================
// BOND YIELDS (TradingView)
// ========================================
export async function fetchBondYields() {
  try {
    const tickers = ['TVC:US10Y', 'TVC:US02Y', 'TVC:IN10Y', 'TVC:JP10Y', 'TVC:DE10Y'];
    const res = await fetch('https://scanner.tradingview.com/bond/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ symbols: { tickers }, columns: ['description', 'close', 'change'] }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const nameMap = { 'TVC:US10Y': 'US 10Y', 'TVC:US02Y': 'US 2Y', 'TVC:IN10Y': 'India 10Y', 'TVC:JP10Y': 'Japan 10Y', 'TVC:DE10Y': 'Germany 10Y' };
    return (data?.data || []).map(item => ({
      name: nameMap[item.s] || item.s,
      yield: parseFloat(item.d?.[1]) || 0,
      change: parseFloat(item.d?.[2]) || 0
    })).filter(b => b.yield > 0);
  } catch (e) {
    console.warn('Bond yields fetch failed:', e.message);
    return [];
  }
}

// ========================================
// FII/DII DATA (via Tavily Search — daily summary)
// ========================================
export async function fetchFIIDIIData(tavilyKey) {
  if (!tavilyKey) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: 'FII DII data today India stock market net buy sell crore',
        search_depth: 'basic',
        include_answer: true,
        max_results: 3,
        topic: 'finance'
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      summary: data.answer || 'FII/DII data unavailable',
      sources: (data.results || []).slice(0, 2).map(r => ({ title: r.title, url: r.url }))
    };
  } catch (e) {
    console.warn('FII/DII fetch failed:', e.message);
    return null;
  }
}

// ========================================
// IPO DATA (via Tavily Search)
// ========================================
export async function fetchIPOData(tavilyKey) {
  if (!tavilyKey) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: `upcoming IPO India ${new Date().getFullYear()} open subscription GMP latest`,
        search_depth: 'basic',
        include_answer: true,
        max_results: 4,
        topic: 'finance'
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      summary: data.answer || 'IPO data unavailable',
      sources: (data.results || []).slice(0, 3).map(r => ({ title: r.title, url: r.url }))
    };
  } catch (e) {
    console.warn('IPO fetch failed:', e.message);
    return null;
  }
}
