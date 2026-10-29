// ============================================================
// v21.23.3 — HONESTY REGRESSION LOCKS (rebuilt-bot edition)
// ------------------------------------------------------------
// v21.23.1/v21.23.2 ne MTFDualBoardPanel header + mtfDualBoard
// server ladder honest kiya, par un-swept paths par fabrications
// zinda reh gaye the:
//   1. Row-level OLLAMA chip raw `verdict` ("3/3 OLLAMA AI LOCK")
//      render karta tha — Ollama OFFLINE ho tab bhi — plus
//      `latencyMs ?? 12` fabricated latency.
//   2. Telegram board rows: `?? 88` winrate + guessed alignment +
//      raw verdict tag.
//   3. bot.mjs digest header flat "95% Win-Rate" claim.
//   4. TradePlanPanel: `?? 7` guessed "7/8" + synthetic formula
//      bare "% Winrate" ke roop me.
//   5. mtfDualBoard API payload note "95% Win-Rate Confluence".
//   6. India/CoinDcx tab headers "(95% Win-Rate Target)".
//   7. llmSentinel cache-init `latencyMs || 18` placeholder leak.
//
// f7c6fe7 rebuilt the Telegram bot: the old siteAgents formatter is
// gone, and the new `formatBoard` never renders winrate/alignment/
// verdict tags at all. These locks now pin the rebuilt renderer.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatBoard } from '../telegram-bot/lib/format.mjs';

const readSrc = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');

const row = (over = {}) => ({
  ok: true,
  symbol: 'BTC',
  side: 'LONG',
  tier: 'ELITE',
  superScore: 80,
  plan: { entry: 67000, stopLoss: 66500, t1: 68000, t2: 69000 },
  ...over,
});

const board = (rows = [row()]) => ({
  ok: true,
  market: 'CRYPTO',
  quoteCcy: 'USDT',
  modeLabel: 'INTRADAY',
  scannedCount: 10,
  asOf: Date.now(),
  rows,
});

describe('v21.23.3 — honesty: telegram MTF board fabrications removed', () => {
  it('unmeasured row → no fabricated winrate / alignment / verdict tag', () => {
    const txt = formatBoard(board([row({
      winRatePct: 95,
      worldIndicators: { alignedCount: 9, aligned8Count: 9 },
      ollamaTrio: { verdict: '3/3 OLLAMA AI LOCK', honestLabel: 'Rule-Based Guard 3/3', ruleBasedGuard: true },
    })]), { title: 'TEST BOARD' });
    expect(txt).toContain('BTC');
    // The rebuilt formatter renders signal/order state + plan only.
    expect(txt).not.toContain('Winrate');
    expect(txt).not.toContain('95%');
    expect(txt).not.toContain('OLLAMA AI LOCK');
    expect(txt).not.toMatch(/\d+\/8 Inst/);
    expect(txt).not.toMatch(/\d+\/10 Top Ind/);
  });

  it('executed order side opposite to signal side → flagged, never hidden', () => {
    const txt = formatBoard(board([row({ orderSide: 'SELL' })]), { title: 'X' });
    expect(txt).toContain('SIDE MISMATCH');
    expect(txt).toContain('order SELL');
  });

  it('matching order side → no false mismatch flag', () => {
    const txt = formatBoard(board([row({ orderSide: 'BUY' })]), { title: 'X' });
    expect(txt).not.toContain('SIDE MISMATCH');
    expect(txt).toContain('order BUY');
  });

  it('row error → secrets redacted before Telegram sees them', () => {
    const txt = formatBoard(board([row({ ok: false, error: 'token=abcdef123456 api_key=supersecret' })]), { title: 'X' });
    expect(txt).toContain('[redacted]');
    expect(txt).not.toContain('supersecret');
    expect(txt).not.toContain('abcdef123456');
  });
});

describe('v21.23.3 — honesty: UI/server source pins', () => {
  it('MTFDualBoardPanel OLLAMA chip consumes honestLabel + honest latency (no ?? 12)', () => {
    const src = readSrc('src/components/aitrading/MTFDualBoardPanel.tsx');
    expect(src).toContain('r.ollamaTrio.honestLabel || r.ollamaTrio.verdict');
    expect(src).not.toContain('latencyMs ?? 12');
  });

  it('useAITrading ollamaTrio type carries honest fields', () => {
    const src = readSrc('src/components/aitrading/useAITrading.ts');
    expect(src).toMatch(/honestLabel\?: string/);
    expect(src).toMatch(/ruleBasedGuard\?: boolean/);
  });

  it('TradePlanPanel: no ?? 7 guessed alignment; synthetic winrate is "~est." qualified', () => {
    const src = readSrc('src/components/aitrading/TradePlanPanel.tsx');
    expect(src).not.toContain('?? 7');
    expect(src).toContain('est. win-rate');
  });

  it('rebuilt bot: no flat 95% win-rate claim + no secret commands', () => {
    const bot = readSrc('telegram-bot/bot.mjs');
    const commands = readSrc('telegram-bot/lib/commands.mjs');
    expect(bot).not.toContain('(95% Win-Rate');
    expect(commands).not.toMatch(/\/(?:setkey|debug_env|env)\b/);
  });

  it('mtfDualBoard API payload note: no "95% Win-Rate Confluence"', () => {
    const src = readSrc('server/ai/mtfDualBoard.js');
    expect(src).not.toContain('95% Win-Rate Confluence');
    expect(src).toContain('Ledger-Calibrated Win-Rate Confluence');
  });

  it('llmSentinel cache-init: latency placeholder leak (|| 18) removed', () => {
    const src = readSrc('server/ai/llmSentinel.js');
    expect(src).not.toContain('latencyMs: cached?.latencyMs || 18');
    expect(src).toContain('latencyMs: cached?.latencyMs ?? null');
  });

  it('tab headers: "(95% Win-Rate Target)" replaced with ledger-calibrated phrasing', () => {
    const cx = readSrc('src/components/tabs/CoinDcxTab.tsx');
    const inr = readSrc('src/components/tabs/IndiaIntradayTab.tsx');
    expect(cx).not.toContain('95% Win-Rate');
    expect(inr).not.toContain('95% Win-Rate');
    expect(cx).toContain('Ledger-Calibrated Win-Rate');
    expect(inr).toContain('Ledger-Calibrated Win-Rate');
  });

  it('rebuilt board formatter: fabricated fallbacks (?? 88 / alignedCount ?? 8) gone', () => {
    const src = readSrc('telegram-bot/lib/format.mjs');
    expect(src).not.toContain('?? 88');
    expect(src).not.toContain('alignedCount ?? 8');
    expect(src).toContain('SIDE MISMATCH');
    expect(src).toContain('redactSecrets(row?.error');
  });
});
