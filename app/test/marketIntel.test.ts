// ============================================================
// marketIntel.test — external free-source intelligence engine
// (server/intraday/intel.js — pure parsers + analysis, no network)
// v4.6: CoinLobster digest/movers/radar, CoinGecko trending,
// Fear&Greed, deep-analysis verdicts, honest source registry.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  parseFearGreed, parseDigest, parseMovers, parseRadar, parseTrending,
  intelAnalysis, extractMcpJson, parseToolPayload, fmtUsdFlow, SOURCE_REGISTRY,
} from '../server/intraday/intel.js';

describe('extractMcpJson / parseToolPayload — CoinLobster SSE shapes', () => {
  it('parses one-line SSE frames ("event: message data: {...}")', () => {
    const text = 'event: message data: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"coinlobster"}}}';
    const j = extractMcpJson(text);
    expect(j?.result?.serverInfo?.name).toBe('coinlobster');
  });

  it('parses multi-line SSE frames', () => {
    const text = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    const j = extractMcpJson(text);
    expect(j?.result?.ok).toBe(true);
  });

  it('parses plain JSON when no data: prefix', () => {
    expect(extractMcpJson('{"a":1}')?.a).toBe(1);
  });

  it('returns null on garbage', () => {
    expect(extractMcpJson('not json at all')).toBeNull();
    expect(extractMcpJson('')).toBeNull();
  });

  it('parseToolPayload unwraps tools/call content text → inner JSON', () => {
    const inner = { gainers: [{ coin: 'BTC', price_usd: 77000, chg_24h_pct: 1.2 }] };
    const frame = `event: message data: ${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify(inner) }] } })}`;
    const p = parseToolPayload(frame);
    expect(p?.gainers?.[0]?.coin).toBe('BTC');
  });
});

describe('parseFearGreed', () => {
  it('maps value to zones and keeps label', () => {
    const fg = parseFearGreed({ data: [{ value: '63', value_classification: 'Greed' }] });
    expect(fg).toEqual({ value: 63, label: 'Greed (63)', zone: 'GREED', rawLabel: 'Greed' });
    expect(parseFearGreed({ data: [{ value: '10', value_classification: 'Extreme Fear' }] }).zone).toBe('EXTREME FEAR');
    expect(parseFearGreed({ data: [{ value: '30', value_classification: 'Fear' }] }).zone).toBe('FEAR');
    expect(parseFearGreed({ data: [{ value: '50', value_classification: 'Neutral' }] }).zone).toBe('NEUTRAL');
    expect(parseFearGreed({ data: [{ value: '90', value_classification: 'Extreme Greed' }] }).zone).toBe('EXTREME GREED');
  });
  it('returns null on broken shapes', () => {
    expect(parseFearGreed(null)).toBeNull();
    expect(parseFearGreed({ data: [] })).toBeNull();
    expect(parseFearGreed({ data: [{ value: 'x' }] })).toBeNull();
  });
});

describe('parseDigest — whale leaders, radar, liquidation fallback', () => {
  const digest = {
    summary: 'Market now: unusual whale flow: BTC · top mover BTC -0.19% · 24h forced closes $1465M long-side',
    whale_leaders: {
      buyers: [{ coin: 'ETH', net_usd_24h: 81791996 }, { coin: 'BNB', net_usd_24h: 1956356 }],
      sellers: [{ coin: 'ZEC', net_usd_24h: -19355310 }, { coin: 'BTC', net_usd_24h: -14692552 }],
    },
    radar_now: [{ coin: 'BTC', window: '1h', direction: 'sell', unusual: false }, { coin: 'KBTC', window: '4h', direction: 'sell', unusual: true }],
    top_movers: [{ coin: 'BTC', price_usd: 77223.15, chg_24h_pct: -0.19 }],
  };

  it('maps whale leaders uppercase + net flows', () => {
    const p = parseDigest(digest);
    expect(p.buyers).toEqual([{ coin: 'ETH', netUsd24h: 81791996 }, { coin: 'BNB', netUsd24h: 1956356 }]);
    expect(p.sellers[0]).toEqual({ coin: 'ZEC', netUsd24h: -19355310 });
    expect(p.radarNow.some(r => r.coin === 'KBTC' && r.unusual)).toBe(true);
  });

  it('regex-fallback extracts long-side forced closes from summary ($1465M)', () => {
    const p = parseDigest(digest);
    expect(p.liqLongUsd).toBe(1465e6);
    expect(p.liqShortUsd).toBeNull();
  });

  it('short-side summary parses too (K suffix)', () => {
    const p = parseDigest({ summary: 'forced closes $850K short-side' });
    expect(p.liqShortUsd).toBe(850e3);
  });

  it('structured liquidation fields win over summary', () => {
    const p = parseDigest({ summary: 'forced closes $1M long-side', liquidations: { usd_24h_long: 5e6, usd_24h_short: 1e6 } });
    expect(p.liqLongUsd).toBe(5e6);
    expect(p.liqShortUsd).toBe(1e6);
  });

  it('returns null on non-object', () => {
    expect(parseDigest(null)).toBeNull();
    expect(parseDigest('x')).toBeNull();
  });
});

describe('parseMovers / parseRadar / parseTrending', () => {
  it('movers: caps at 10, filters coinless, keeps null vol', () => {
    const p = parseMovers({
      gainers: Array.from({ length: 14 }, (_, i) => ({ coin: `C${i}`, price_usd: 1 + i, chg_24h_pct: 5 - i })),
      losers: [{ coin: 'BTR', price_usd: 0.01, chg_24h_pct: -46.8, vol_usd_24h: 2e6 }, { price_usd: 1 }],
    });
    expect(p.gainers.length).toBe(10);
    expect(p.losers).toEqual([{ coin: 'BTR', priceUsd: 0.01, chgPct24h: -46.8, volUsd24h: 2e6 }]);
    expect(parseMovers(null)).toBeNull();
    expect(parseMovers({ losers: [] })).toBeNull();
  });

  it('radar: windows 1h/4h rows with net flow', () => {
    const p = parseRadar({ windows: { '1h': [{ coin: 'BTC', netUsd: -23284728, buyUsd: 1, sellUsd: 2 }], '4h': [{ coin: 'ARB', netUsd: 5e6, buyUsd: 6e6, sellUsd: 1e6 }] } });
    expect(p[0]).toMatchObject({ coin: 'BTC', window: '1h', netUsd: -23284728 });
    expect(p[1]).toMatchObject({ coin: 'ARB', window: '4h' });
    expect(parseRadar(null)).toBeNull();
  });

  it('trending: CoinGecko shape → symbol/name/rank/24h', () => {
    const p = parseTrending({ coins: [{ item: { symbol: 'ake', name: 'Akedo', market_cap_rank: 117, data: { price_change_percentage_24h: { usd: 117.35 } } } }] });
    expect(p[0]).toEqual({ symbol: 'AKE', name: 'Akedo', rank: 117, chgPct24hUsd: 117.35 });
    expect(parseTrending(null)).toBeNull();
    expect(parseTrending({ coins: 'nope' })).toBeNull();
  });
});

describe('intelAnalysis — deterministic deep verdicts', () => {
  const digest = {
    buyers: [{ coin: 'ETH', netUsd24h: 81791996 }],
    sellers: [{ coin: 'BTC', netUsd24h: -14692552 }],
    radarNow: [], topMovers: [], liqLongUsd: 1465e6, liqShortUsd: 0,
    summary: '',
  };

  it('whale net-flow direction + liquidation skew + bullets', () => {
    const a = intelAnalysis({ fearGreed: { value: 63, label: 'Greed (63)', zone: 'GREED', rawLabel: 'Greed' }, digest, movers: null, trending: null });
    expect(a.whales.direction).toBe('ACCUMULATION');
    expect(a.whales.netUsd).toBeCloseTo(81791996 - 14692552, -4);
    expect(a.liquidations.longSharePct).toBe(100);
    expect(a.bullets.some(b => b.includes('Liquidations'))).toBe(true);
    // Greed (56-75) → -1 · whale net>0 → +1 · long-flush bounce fuel → +1 = +1 → CAUTIOUS-BULLISH
    expect(a.bias).toBe('CAUTIOUS-BULLISH');
  });

  it('contrarian divergences flip bias', () => {
    // Extreme fear + whale accumulation → buy-the-fear setup
    const a1 = intelAnalysis({ fearGreed: { value: 20, label: 'Extreme Fear', zone: 'EXTREME FEAR', rawLabel: 'Extreme Fear' }, digest, movers: null, trending: null });
    expect(a1.bullets.some(b => b.includes('buy-the-fear'))).toBe(true);
    expect(a1.bias).toBe('RISK-ON');
    // Extreme greed + whale distribution → risk-off
    const a2 = intelAnalysis({
      fearGreed: { value: 90, label: 'Extreme Greed', zone: 'EXTREME GREED', rawLabel: 'Extreme Greed' },
      digest: { buyers: [], sellers: [{ coin: 'BTC', netUsd24h: -5e7 }], radarNow: [], topMovers: [], liqLongUsd: null, liqShortUsd: null, summary: '' },
      movers: null, trending: null,
    });
    expect(a2.bullets.some(b => b.includes('distribution-into-euphoria'))).toBe(true);
    expect(a2.bias).toBe('RISK-OFF');
  });

  it('retail-whale overlap + thin-volume pump warning', () => {
    const digest2 = { ...digest, topMovers: [{ coin: 'AKE', priceUsd: 0.018, chgPct24h: null }, { coin: 'BTC', priceUsd: 77000, chgPct24h: -0.2 }] };
    const trending = [{ symbol: 'AKE', name: 'Akedo', rank: 117, chgPct24hUsd: 117 }, { symbol: 'BTC', name: 'Bitcoin', rank: 1, chgPct24hUsd: -0.1 }, { symbol: 'SOL', name: 'Solana', rank: 5, chgPct24hUsd: 3 }];
    const movers = { gainers: [{ coin: 'PUMPX', priceUsd: 1, chgPct24h: 45, volUsd24h: null }, { coin: 'FAKE2', priceUsd: 2, chgPct24h: 33, volUsd24h: 1e6 }], losers: [] };
    const a = intelAnalysis({ fearGreed: null, digest: digest2, movers, trending });
    expect(a.bullets.some(b => b.includes('overlap: AKE'))).toBe(true);
    expect(a.bullets.some(b => b.includes('Pump-check'))).toBe(true);
  });

  it('empty parts → neutral, no crash', () => {
    const a = intelAnalysis({});
    expect(a.bias).toBe('NEUTRAL');
    expect(a.bullets).toEqual([]);
    expect(a.verdict).toContain('mixed');
  });
});

describe('fmtUsdFlow + SOURCE_REGISTRY honesty', () => {
  it('humanizes $ flows', () => {
    expect(fmtUsdFlow(1.5e9)).toBe('$1.50B');
    expect(fmtUsdFlow(-146.5e6)).toBe('-$146.5M');
    expect(fmtUsdFlow(850e3)).toBe('$850K');
    expect(fmtUsdFlow(null)).toBeNull();
  });

  it('registry marks verified-live sources and honestly flags dead/auth ones', () => {
    const names = SOURCE_REGISTRY.map(s => s.name);
    expect(names).toContain('CoinLobster MCP');
    const dead = SOURCE_REGISTRY.filter(s => s.expected === 'DEAD');
    expect(dead.length).toBe(2); // Upstox demo + Bitget datahub
    expect(SOURCE_REGISTRY.find(s => s.name.includes('Tapetide')).expected).toBe('AUTH');
    // every entry carries an explanatory note (UI footer tooltip)
    for (const s of SOURCE_REGISTRY) expect(s.note.length).toBeGreaterThan(5);
  });
});
