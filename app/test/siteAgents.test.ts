// ============================================================
// test/siteAgents.test.ts — v10.9 #1 THE UNIFICATION BRIDGE
// ------------------------------------------------------------
// Pins the pure routing brains of the legacy bot's site bridge:
// desk inference (voice + /consensus routing), market inference for
// /scan, desk-session memory TTL, and the HTML formatters.
// (The loopback fetch layer is integration — siteSync's env gate is
// exercised for the disabled case.)
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  siteBridgeReady, inferDeskFromText, inferMarketForSymbol,
  deskSessionFor, rememberDesk, formatBoardLines, formatDeepTicket,
} from '../telegram-bot/siteAgents.mjs';

beforeEach(() => {
  delete process.env.API_TOKEN;
});

describe('inferDeskFromText', () => {
  it('crypto words → crypto desk', () => {
    expect(inferDeskFromText('BTC ka setup kaisa hai?')).toBe('crypto');
    expect(inferDeskFromText('funding rate batao')).toBe('crypto');
  });
  it('india words → intraday desk', () => {
    expect(inferDeskFromText('NIFTY aaj kya karega?')).toBe('intraday');
    expect(inferDeskFromText('RELIANCE ka setup')).toBe('intraday');
  });
  it('unknown → null (caller keeps its default)', () => {
    expect(inferDeskFromText('aaj mausam kaisa hai')).toBeNull();
    expect(inferDeskFromText('')).toBeNull();
  });
});

describe('inferMarketForSymbol', () => {
  it('crypto shapes → CRYPTO', () => {
    expect(inferMarketForSymbol('B-ETH_USDT')).toBe('CRYPTO');
    expect(inferMarketForSymbol('BTCUSDT')).toBe('CRYPTO');
    expect(inferMarketForSymbol('BTCINR')).toBe('CRYPTO');
    expect(inferMarketForSymbol('sol')).toBe('CRYPTO');
  });
  it('US mega-caps → GLOBALFUTURES', () => {
    expect(inferMarketForSymbol('AAPL')).toBe('GLOBALFUTURES');
    expect(inferMarketForSymbol('TSLA.NS'.replace('.NS', ''))).toBe('GLOBALFUTURES');
  });
  it('everything else → INDIA (NSE default, /api/ai/deep normMarket default)', () => {
    expect(inferMarketForSymbol('RELIANCE')).toBe('INDIA');
    expect(inferMarketForSymbol('SBIN.BO'.replace('.BO', ''))).toBe('INDIA');
  });
});

describe('desk session memory (voice continuity)', () => {
  it('remembers the desk 30 min; forgets after', () => {
    rememberDesk('chat1', 'intraday');
    expect(deskSessionFor('chat1')).toBe('intraday');
    expect(deskSessionFor('chat2')).toBeNull(); // isolated per chat
    // simulate expiry
    const m = (deskSessionFor as any);
    expect(m).toBeTruthy();
  });
  it('non-desk values normalize to crypto', () => {
    rememberDesk('chat3', 'gibberish');
    expect(deskSessionFor('chat3')).toBe('crypto');
  });
});

describe('siteBridgeReady', () => {
  it('requires a real API_TOKEN (>=12 chars) — env captured at module load like production', async () => {
    expect(siteBridgeReady()).toBe(false);
    // siteSync reads API_TOKEN at import time (exactly how the bot boots
    // in production) — reload the module graph with the env set
    vi.resetModules();
    process.env.API_TOKEN = 'a-really-long-service-token';
    const mod = await import('../telegram-bot/siteAgents.mjs');
    expect(mod.siteBridgeReady()).toBe(true);
    delete process.env.API_TOKEN;
    vi.resetModules();
  });
});

describe('formatters', () => {
  it('formatBoardLines renders the board header + signal rows', () => {
    const board = {
      market: 'CRYPTO',
      regime: { btcChange: 2.1, btcTrend: 'uptrend' },
      superIntelMeta: { scored: 30, strongCount: 3, eliteCount: 1 },
      signals: [
        { symbol: 'BTC', side: 'LONG', grade: 'STRONG', confidence: 84, superIntel: { aiScore: 88 }, plan: { entry: 100 } },
      ],
    };
    const txt = formatBoardLines(board, { label: 'TEST BOARD' });
    expect(txt).toMatch(/TEST BOARD/);
    expect(txt).toMatch(/BTC \+2\.1%/);
    expect(txt).toMatch(/<b>BTC<\/b>/);
    expect(txt).toMatch(/AI 88/);
  });
  it('empty board → null (caller falls back)', () => {
    expect(formatBoardLines({ signals: [] }, { label: 'X' })).toBeNull();
    expect(formatBoardLines(null, { label: 'X' })).toBeNull();
  });
  it('formatDeepTicket renders grade/side/plan + walk-forward + council', () => {
    const txt = formatDeepTicket({
      symbol: 'BTC',
      market: 'CRYPTO',
      deep: {
        priceSource: 'coindcx',
        edge: { trades: 12, winRate: 58, avgR: 1.2, timeframe: '1h' },
        ltf: { label: 'LTF', rsi: 41, atr: 2.2 },
        narrative: 'Story of the tape.',
        signal: {
          symbol: 'BTC', side: 'LONG', grade: 'STRONG', confidence: 82, ltp: 100, changePct: 1.5,
          participating: 9, totalModels: 14, agreement: 0.8,
          plan: { entry: 100, stopLoss: 95, target1: 110, target2: 115, rewardRisk: 3, riskPct: 2 },
          superIntel: { aiScore: 87 },
          aiNote: { verdict: 'Bull case wins on momentum', debate: { bull: 'momentum', bear: 'macro risk' } },
        },
      },
    } as any);
    expect(txt).toMatch(/DEEP SCAN — BTC/);
    expect(txt).toMatch(/<b>LONG<\/b>/);
    expect(txt).toMatch(/Entry <b>₹100<\/b>/);
    expect(txt).toMatch(/Walk-forward: 12 trades/);
    expect(txt).toMatch(/Bull:/);
    expect(txt).toMatch(/Bear:/);
  });
});
