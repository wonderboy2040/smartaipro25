// ============================================================
// v21.23.3 — HONESTY REGRESSION LOCKS
// ------------------------------------------------------------
// WHY: v21.23.1/v21.23.2 ne MTFDualBoardPanel header + mtfDualBoard
// server ladder honest kiya, par 3 un-swept paths par fabrications
// zinda reh gaye the (fresh-eyes deep audit ne pakde):
//   1. Row-level OLLAMA chip raw `verdict` ("3/3 OLLAMA AI LOCK")
//      render karta tha — Ollama OFFLINE ho tab bhi — plus
//      `latencyMs ?? 12` fabricated latency.
//   2. Telegram siteAgents row: `?? 88` winrate + `?? 8` guessed
//      alignment + raw verdict tag.
//   3. bot.mjs digest header flat "95% Win-Rate" claim.
//   4. TradePlanPanel: `?? 7` guessed "7/8" + synthetic formula
//      bare "% Winrate" ke roop me.
//   5. mtfDualBoard API payload note "95% Win-Rate Confluence".
//   6. India/CoinDcx tab headers "(95% Win-Rate Target)".
//   7. llmSentinel cache-init `latencyMs || 18` placeholder leak.
// Ye file in sab ko behavior + source pins se lock karti hai.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatMtfDualBoardLines } from '../telegram-bot/siteAgents.mjs';

const readSrc = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');

describe('v21.23.3 — honesty: telegram MTF row fabrications removed', () => {
  it('unmeasured row → "Winrate: calibrating", NOT guessed 88%/8-of-8', () => {
    const txt = formatMtfDualBoardLines({
      rows: [{ symbol: 'BTC', side: 'LONG', superScore: 80, tier: 'ELITE', plan: { entry: 67000, stopLoss: 66500, t1: 68000, t2: 69000 } }],
    }, { label: 'TEST BOARD', max: 6 });
    expect(txt).toBeTruthy();
    expect(txt).toContain('Winrate: calibrating');
    expect(txt).not.toContain('88% Winrate');
    // guessed alignment bhi nahi — unknown pe "—" (em-dash) indicator
    expect(txt).toContain('—/8 Inst · —/10 Top Ind');
    expect(txt).not.toContain('8/8 Inst');
  });

  it('measured row → real winRatePct + real alignment counts render', () => {
    const txt = formatMtfDualBoardLines({
      rows: [{
        symbol: 'BTC', side: 'LONG', superScore: 80, tier: 'ELITE',
        winRatePct: 72,
        worldIndicators: { alignedCount: 7, aligned8Count: 6 },
        plan: { entry: 67000, stopLoss: 66500, t1: 68000, t2: 69000 },
      }],
    }, { label: 'TEST BOARD', max: 6 });
    expect(txt).toContain('72% Winrate');
    expect(txt).toContain('6/8 Inst · 7/10 Top Ind');
  });

  it('offline Ollama → honestLabel ("Rule-Based Guard n/3") renders, raw "3/3 OLLAMA AI LOCK" NOT', () => {
    const txt = formatMtfDualBoardLines({
      rows: [{
        symbol: 'BTC', side: 'LONG', superScore: 80, tier: 'ELITE',
        ollamaTrio: { verdict: '3/3 OLLAMA AI LOCK', honestLabel: 'Rule-Based Guard 3/3', ruleBasedGuard: true },
        plan: { entry: 67000, stopLoss: 66500, t1: 68000, t2: 69000 },
      }],
    }, { label: 'TEST BOARD', max: 6 });
    expect(txt).toContain('Rule-Based Guard 3/3');
    expect(txt).not.toContain('3/3 OLLAMA AI LOCK');
  });

  it('legacy rows (no honestLabel) → verdict fallback still works (back-compat)', () => {
    const txt = formatMtfDualBoardLines({
      rows: [{
        symbol: 'BTC', side: 'LONG', superScore: 80, tier: 'ELITE',
        ollamaTrio: { verdict: '2/3 OLLAMA AI STRONG' },
        plan: { entry: 67000, stopLoss: 66500, t1: 68000, t2: 69000 },
      }],
    }, { label: 'TEST BOARD', max: 6 });
    expect(txt).toContain('2/3 OLLAMA AI STRONG');
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

  it('bot.mjs digest header: no flat 95% win-rate claim', () => {
    const src = readSrc('telegram-bot/bot.mjs');
    expect(src).not.toContain('(95% Win-Rate');
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

  it('siteAgents: fabricated fallbacks (?? 88 / ?? 8) gone from source', () => {
    const src = readSrc('telegram-bot/siteAgents.mjs');
    expect(src).not.toContain('?? r.plan?.winProbPct ?? 88');
    expect(src).not.toContain('alignedCount ?? 8');
    expect(src).toContain('honestLabel');
  });
});
