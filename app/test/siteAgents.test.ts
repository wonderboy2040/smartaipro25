// ============================================================
// test/siteAgents.test.ts — REBUILT BOT CORE CONTRACTS
// ------------------------------------------------------------
// The legacy `telegram-bot/siteAgents.mjs` bridge was removed by the
// owner-only bot rebuild (f7c6fe7). This suite now pins the behaviour
// that actually ships:
//   • parseCommand / resolveCommand / marketFromArgs / isMarketArg
//   • inferDesk (voice + /agent routing)
//   • formatBoard HTML renderer (header, rows, metals, honest errors)
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  inferDesk,
  isMarketArg,
  marketFromArgs,
  parseCommand,
  resolveCommand,
} from '../telegram-bot/lib/commands.mjs';
import { formatBoard } from '../telegram-bot/lib/format.mjs';

const boardRow = (over = {}) => ({
  ok: true,
  symbol: 'BTC',
  side: 'LONG',
  tier: 'ELITE',
  superScore: 88,
  autoEligible: true,
  triggerFired: true,
  directionVerified: true,
  plan: { entry: 67000, stopLoss: 66500, t1: 68000, t2: 69000 },
  ...over,
});

const board = (over = {}) => ({
  ok: true,
  market: 'CRYPTO',
  quoteCcy: 'USDT',
  modeLabel: 'INTRADAY',
  scannedCount: 12,
  asOf: Date.now(),
  rows: [boardRow()],
  ...over,
});

describe('parseCommand', () => {
  it('parses a bare command + args', () => {
    expect(parseCommand('/status')).toEqual({ name: 'status', args: '', mentioned: false });
    expect(parseCommand('  /scan crypto  ')).toEqual({ name: 'scan', args: 'crypto', mentioned: false });
  });
  it('strips a matching @mention and lowercases the command', () => {
    expect(parseCommand('/Signals@TestBot crypto', 'testbot')).toEqual({
      name: 'signals',
      args: 'crypto',
      mentioned: true,
    });
  });
  it('rejects a mention aimed at another bot', () => {
    expect(parseCommand('/signals@OtherBot', 'testbot')).toBeNull();
  });
  it('rejects plain text (chat is handled by inferDesk/agent)', () => {
    expect(parseCommand('BTC kaisa hai?')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });
});

describe('resolveCommand aliases', () => {
  it('maps short aliases to canonical handlers', () => {
    expect(resolveCommand('s')).toEqual({ name: 'status', args: '' });
    expect(resolveCommand('mtf')).toEqual({ name: 'signals', args: '' });
    expect(resolveCommand('portfolio')).toEqual({ name: 'positions', args: '' });
    expect(resolveCommand('push')).toEqual({ name: 'alerts', args: '' });
    expect(resolveCommand('ask')).toEqual({ name: 'agent', args: '' });
  });
  it('gold/silver short-circuit to the metals board', () => {
    expect(resolveCommand('gold')).toEqual({ name: 'signals', args: 'metals' });
    expect(resolveCommand('silver')).toEqual({ name: 'signals', args: 'metals' });
  });
  it('unknown commands pass through unchanged', () => {
    expect(resolveCommand('weekly')).toEqual({ name: 'weekly', args: '' });
  });
});

describe('marketFromArgs / isMarketArg', () => {
  it('maps market aliases to board markets', () => {
    expect(marketFromArgs('crypto')).toBe('CRYPTO');
    expect(marketFromArgs('btc')).toBe('CRYPTO');
    expect(marketFromArgs('india')).toBe('INDIA');
    expect(marketFromArgs('nse')).toBe('INDIA');
    expect(marketFromArgs('gold')).toBe('METALS');
    expect(marketFromArgs('futures')).toBe('FUTURES');
    expect(marketFromArgs('us')).toBe('GLOBALFUTURES');
  });
  it('falls back for empty/unknown input (default CRYPTO)', () => {
    expect(marketFromArgs('')).toBe('CRYPTO');
    expect(marketFromArgs('gibberish')).toBe('CRYPTO');
    expect(marketFromArgs('gibberish', 'INDIA')).toBe('INDIA');
  });
  it('isMarketArg accepts empty (default board) and known aliases only', () => {
    expect(isMarketArg('')).toBe(true);
    expect(isMarketArg('metals')).toBe(true);
    expect(isMarketArg('definitely-not-a-market')).toBe(false);
  });
});

describe('inferDesk', () => {
  it('crypto words → crypto desk', () => {
    expect(inferDesk('BTC ka setup kaisa hai?')).toBe('crypto');
    expect(inferDesk('BTC funding rate batao')).toBe('crypto');
    expect(inferDesk('XAU gold perp signal batao')).toBe('crypto');
  });
  it('india words → india desk', () => {
    expect(inferDesk('NIFTY aaj kya karega?')).toBe('india');
    expect(inferDesk('RELIANCE ka setup')).toBe('india');
    expect(inferDesk('SBIN.NS chart')).toBe('india');
  });
  it('unknown/empty → null (caller keeps its default)', () => {
    expect(inferDesk('aaj mausam kaisa hai')).toBeNull();
    expect(inferDesk('')).toBeNull();
  });
});

describe('formatBoard', () => {
  it('renders header, stats and the signal row with plan levels', () => {
    const txt = formatBoard(board(), { title: 'TEST BOARD', market: 'CRYPTO', now: Date.now() });
    expect(txt).toContain('TEST BOARD');
    expect(txt).toContain('CRYPTO');
    expect(txt).toContain('12 scanned');
    expect(txt).toMatch(/<b>BTC<\/b>/);
    expect(txt).toContain('ELITE');
    expect(txt).toContain('PAKKA');
    expect(txt).toContain('E 67,000.00 USDT');
    expect(txt).toContain('SL 66,500.00 USDT');
    expect(txt).toContain('T1 68,000.00 USDT');
  });

  it('renders GOLD / SILVER and equity-sim sections, de-duplicated', () => {
    const txt = formatBoard(board({
      rows: [],
      metalsRows: [boardRow({ symbol: 'XAU', plan: { entry: 2745, stopLoss: 2730, t1: 2765, t2: 2790 } })],
      equitySimRows: [boardRow({ symbol: 'NVDA', tier: 'STRONG', plan: { entry: 138.5, stopLoss: 136.2, t1: 141, t2: 144.5 } })],
    }), { title: 'X' });
    expect(txt).toContain('GOLD / SILVER (USDT)');
    expect(txt).toContain('XAU');
    expect(txt).toContain('EQUITY SIM (USD)');
    expect(txt).toContain('NVDA');
  });

  it('metalsOnly renders only the gold/silver section', () => {
    const txt = formatBoard(board({
      rows: [],
      metalsRows: [boardRow({ symbol: 'XAU', plan: { entry: 2745, stopLoss: 2730, t1: 2765, t2: 2790 } })],
    }), { metalsOnly: true });
    expect(txt).toContain('GOLD / SILVER (USDT)');
    expect(txt).toContain('XAU');
    expect(txt).not.toContain('<b>MAIN</b>');
  });

  it('empty board → honest "no qualifying setups" (not a fake row)', () => {
    const txt = formatBoard(board({ rows: [], scannedCount: 3 }), { title: 'X' });
    expect(txt).toContain('No qualifying setups');
    expect(txt).not.toMatch(/<b>BTC<\/b>/);
  });

  it('not-ok board throws the real error (caller renders an honest failure)', () => {
    expect(() => formatBoard(null)).toThrow(/board unavailable/i);
    expect(() => formatBoard({ ok: false, error: { message: 'scan failed' } })).toThrow('scan failed');
  });

  it('row-level failure renders redacted error, never the secret', () => {
    const txt = formatBoard(board({
      rows: [boardRow({ ok: false, error: 'api_key=supersecret123 token=abcdef' })],
    }), { title: 'X' });
    expect(txt).toContain('[redacted]');
    expect(txt).not.toContain('supersecret123');
    expect(txt).not.toContain('abcdef');
  });
});
