// ============================================================
// test/agentMemory.test.ts — v10.8 PRO #3 LIGHTWEIGHT CHAT MEMORY
//
// LOCKED HERE:
//   • rememberChat records the turn with symbols + topics extracted
//   • symbol extraction: known whitelist + pair shapes (B-SOL_USDT,
//     SOLINR, SOL-USD) — never hallucinated tickers
//   • memoryContextFor renders recent turns + recurring focus, null
//     on a fresh desk (zero prompt bloat)
//   • ring cap 60/desk, prompt window 8
//   • unknown desk / empty question → honest no-op
// Isolated data dir — never touches the real server/data.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-agent-memory');

import {
  rememberChat, memoryContextFor, memoryStats, extractSymbols,
  __resetMemoryForTests, __memoryRawForTests,
} from '../server/ai/agentMemory.js';

beforeEach(() => {
  __resetMemoryForTests();
});

describe('extractSymbols — whitelist + pair shapes', () => {
  it('known symbols are picked up case-insensitively', () => {
    expect(extractSymbols('SOL kaisa lag raha hai?')).toEqual(['SOL']);
    expect(extractSymbols('btc ya eth me se kya?')).toEqual(['BTC', 'ETH']);
  });
  it('pair shapes resolve to their base', () => {
    expect(extractSymbols('B-SOL_USDT pe view')).toEqual(['SOL']);
    expect(extractSymbols('BTCINR book dekh ke')).toEqual(['BTC']);
    expect(extractSymbols('AAPL-USD wale global desk')).toEqual(['AAPL']);
  });
  it('unknown tickers are NOT hallucinated into symbols', () => {
    expect(extractSymbols('xyzzabc kya karein?')).toEqual([]);
    expect(extractSymbols('hello how are you')).toEqual([]);
  });
  it('capped at 6 symbols', () => {
    expect(extractSymbols('BTC ETH SOL XRP DOGE ADA AVAX LINK')).toHaveLength(6);
  });
});

describe('rememberChat — the record', () => {
  it('records q + a with symbols and topics, returns true', () => {
    expect(rememberChat('crypto', { q: 'SOL pe long karu?', a: 'Entry 142, SL 138 — trend intact' })).toBe(true);
    const raw = __memoryRawForTests();
    expect(raw.desks.crypto).toHaveLength(1);
    const e = raw.desks.crypto[0];
    expect(e.symbols).toContain('SOL');
    expect(e.topics).toContain('buy-call');
    expect(e.q).toMatch(/SOL pe long/);
  });

  it('empty question is a no-op; unknown desk is a no-op', () => {
    expect(rememberChat('crypto', { q: '', a: 'x' })).toBe(false);
    expect(rememberChat('bogus', { q: 'hi', a: 'x' })).toBe(false);
    expect(rememberChat('crypto', {})).toBe(false);
  });

  it('answer text contributes symbols too', () => {
    rememberChat('crypto', { q: 'kya buy karu?', a: 'RELIANCE nahi — ye crypto desk hai; BTC dekho' });
    const e = __memoryRawForTests().desks.crypto[0];
    expect(e.symbols).toContain('BTC');
  });

  it('the ring is capped (61st entry evicts the 1st)', () => {
    for (let i = 0; i < 62; i++) rememberChat('crypto', { q: `question ${i}`, a: `answer ${i}` });
    const ring = __memoryRawForTests().desks.crypto;
    expect(ring.length).toBe(60);
    expect(ring[0].q).toBe('question 2'); // 0 and 1 evicted
  });

  it('desks are isolated — crypto history never leaks into india', () => {
    rememberChat('crypto', { q: 'SOL pe view diya tha 142 pe', a: 'x' });
    rememberChat('india', { q: 'RELIANCE pe view', a: 'y' });
    const india = memoryContextFor('india');
    expect(india).toMatch(/RELIANCE/);
    expect(india).not.toMatch(/SOL pe view diya tha/); // the crypto TURN text never leaks (the generic instruction example may mention SOL)
    expect(memoryContextFor('crypto')).toMatch(/SOL pe view diya tha/);
  });
});

describe('memoryContextFor — the prompt block', () => {
  it('null on a fresh desk (zero bloat)', () => {
    expect(memoryContextFor('crypto')).toBeNull();
  });

  it('renders recent turns + the continuity instruction', () => {
    rememberChat('crypto', { q: 'SOL kaisa lag raha hai?', a: 'SHORT view tha — 68% conf @ 142' });
    rememberChat('crypto', { q: 'risk kitna rakhun?', a: '1% per trade, SL-distance based' });
    const ctx = memoryContextFor('crypto');
    expect(ctx).toMatch(/SOL/);
    expect(ctx).toMatch(/SHORT view/);
    expect(ctx).toMatch(/Recent conversations with this user/);
    expect(ctx).toMatch(/recurring focus/i);
    expect(ctx).toMatch(/Never contradict/);
  });

  it('the recurring-focus tally ranks the most-asked symbol', () => {
    for (let i = 0; i < 3; i++) rememberChat('crypto', { q: `BTC ${i}`, a: 'x' });
    rememberChat('crypto', { q: 'ETH kaisa?', a: 'x' });
    const ctx = memoryContextFor('crypto');
    expect(ctx).toMatch(/recurring focus: BTC/);
  });

  it('stats expose the ring state', () => {
    rememberChat('protrade', { q: 'NIFTY aaj kya karein?', a: 'x' });
    const s = memoryStats('protrade');
    expect(s.entries).toBe(1);
    expect(s.cap).toBe(60);
    expect(s.promptWindow).toBe(1);
  });
});
