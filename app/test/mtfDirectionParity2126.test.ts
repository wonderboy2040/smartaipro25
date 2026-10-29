// ============================================================
// test/mtfDirectionParity2126.test.ts — v21.26.0 DIRECTION + FUTURES-DOMAIN
// ------------------------------------------------------------
// USER REPORT (2026-10-29): "crypto auto trade 2 baar wrong direction trade
// laga hai — Long signal par short ka laga; live market candles ka data
// Websocket Futures se lelo, Spot se nahi."
//
// This suite locks the two root-cause fixes:
//   A) AUTO-MODE PARITY — the board must open on / stay pinned to the mode
//      the auto engine trades (SWING), with a visible badge + mismatch warning.
//      The WLD 2026-10-29 mismatch: visible INTRADAY LONG row vs executed
//      SWING SHORT trade.
//   B) DIRECTION-PARITY — `ensembleSignalAvailable` requires the main
//      AI-BOARD side to EXACTLY equal the MTF row side (opposite board side
//      can never be "ensemble available" even if grade/conf pass).
//   C) FUTURES-ONLY CANDLES — crypto/futures HTF bias + USDT plan chain must
//      never silently fall back to Binance/Bybit SPOT (futures fapi/linear
//      replacement), so the displayed signal and the executed perp plan are
//      computed from the same venue family.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildDualRow } from '../server/ai/mtfDualBoard.js';
import { __resetDirectionLocksForTests } from '../server/ai/directionLock.js';

const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8');

// Hermetic strong-uptrend candles: the planner resolves a LONG side; only
// the board-side equality gate is under test (no network, no HTF fetch
// because `candlesFor` is injected).
const mkCandles = (n = 180, base = 100, step = 0.35) => Array.from({ length: n }, (_, i) => ({
  time: 1_700_000_000_000 + i * 300_000,
  open: base + i * step,
  high: base + i * step + 0.25,
  low: base + i * step - 0.15,
  close: base + (i + 1) * step,
  volume: 1000 + i * 5,
}));
const candlesFor = async () => mkCandles();

describe('v21.26.0 A) direction parity — ensembleSignalAvailable requires side equality', () => {
  beforeEach(() => __resetDirectionLocksForTests());

  it('opposite board side is NEVER ensemble-available (even with STRONG grade + high conf)', async () => {
    const opposing = {
      side: 'SHORT', grade: 'STRONG', confidence: 88,
      superIntel: { aiScore: 90 },
      agreement: 0.85, voters: 12,
    };
    const r = await buildDualRow({
      symbol: 'PARITY', market: 'CRYPTO', boardSig: opposing,
      modeId: 'INTRADAY', holdMin: 45, candlesFor,
    });
    expect(r.ok).toBe(true);
    expect(r.side).toBe('LONG');
    expect(r.boardSideConflict).toBe(true);
    expect(r.ensembleSignalAvailable).toBe(false);
    expect(r.autoEligible).toBe(false);
  });

  it('same board side remains ensemble-available (no gate relaxation for the aligned case)', async () => {
    const aligned = {
      side: 'LONG', grade: 'STRONG', confidence: 82,
      superIntel: { aiScore: 88 },
      agreement: 0.82, voters: 11,
    };
    const r = await buildDualRow({
      symbol: 'PARITY2', market: 'CRYPTO', boardSig: aligned,
      modeId: 'INTRADAY', holdMin: 45, candlesFor,
    });
    expect(r.ok).toBe(true);
    expect(r.side).toBe('LONG');
    expect(r.boardSideConflict).toBe(false);
    expect(r.ensembleSignalAvailable).toBe(true);
  });

  it('mtfAutoLink primary eligible lane explicitly blocks boardSideConflict', () => {
    const src = read('server/ai/mtfAutoLink.js');
    const primary = src.slice(src.indexOf('let eligible = picks.filter'));
    expect(primary).toContain('&& !r.boardSideConflict');
  });
});

describe('v21.26.0 B) futures-domain candles — no silent spot fallback', () => {
  it('HTF 4h/1d bias rides rawTfCandlesUsdt (CoinDCX perp REST + futures WS overlay)', () => {
    const src = read('server/ai/mtf.js');
    const start = src.indexOf('async function _htfCandlesFor');
    const end = src.indexOf('export async function buildHtfBiasSnapshot', start);
    const helper = src.slice(start, end);
    expect(helper).toContain("mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'METALS'");
    expect(helper).toContain('rawTfCandlesUsdt(symbol, tf)');
    // Crypto/futures/metals branch returns BEFORE the spot resolver tail;
    // only non-crypto markets (INDIA/GLOBALFUTURES) may reach `_candlesFor`.
    const cryptoBranch = helper.indexOf("mkt === 'CRYPTO'");
    const futuresLeg = helper.indexOf('rawTfCandlesUsdt(symbol, tf)');
    const spotTail = helper.indexOf('return await _candlesFor(symbol, mkt, tf)');
    expect(cryptoBranch).toBeGreaterThan(-1);
    expect(futuresLeg).toBeGreaterThan(cryptoBranch);
    expect(spotTail).toBeGreaterThan(futuresLeg);
  });

  it('rawTfCandlesUsdt fallback is Binance/Bybit USDT-M futures, never spot', () => {
    const src = read('server/ai/mtf.js');
    expect(src).toContain('fetchBinanceFutKlines(base, tf, 240)');
    expect(src).toContain("src: 'binance-fut-usdt'");
    expect(src).not.toContain('fetchBinanceKlines(base, tf, { limit: 200');
    expect(src).not.toContain("src: 'binance-usdt'");
    expect(src).not.toContain("src: 'coindcx-inr-scaled'");
  });

  it('FUTURES 15m tape + ultrafast verifier fallbacks use USDT-M futures', () => {
    const signals = read('server/ai/signals.js');
    expect(signals).toContain('fetchBinanceFutKlines(base, \'15m\')');
    const ucv = read('server/ai/ultrafastVerifier.js');
    expect(ucv).toContain('return await fetchBinanceFutKlines(base, tf)');
  });

  it('v21.26.5: main FUTURES board candle chain falls back to USDT-M futures (never an empty board on a CoinDCX candle WAF blip)', () => {
    const signals = read('server/ai/signals.js');
    const leg1 = signals.indexOf("fetchFuturesCandles(futuresPairFor(b), '60')");
    const leg2 = signals.indexOf("fetchBinanceFutKlines(b, '60')");
    expect(leg1).toBeGreaterThan(-1);
    expect(leg2).toBeGreaterThan(leg1); // fallback sits AFTER the CoinDCX perp leg
  });

  it('v21.26.5: an empty scan cannot overwrite a last-GOOD board cache (auto-lane poison guard)', () => {
    const signals = read('server/ai/signals.js');
    expect(signals).toContain('const priorGood = !!prior && prior.ok === true');
    expect(signals).toContain('if (!priorGood) cacheSet(cacheKey, payload)');
  });
});

describe('v21.26.0 C) MTF board opens on the AUTO engine mode', () => {
  it('panel persists + hydrates the auto mode and renders an explicit AUTO MODE badge', () => {
    const ui = read('src/components/aitrading/MTFDualBoardPanel.tsx');
    expect(ui).toContain('AUTO_MODE_STORE_KEY');
    expect(ui).toContain('readStoredAutoView');
    expect(ui).toContain('persistAutoView');
    expect(ui).toContain('data-testid="mtf-auto-mode-badge"');
    expect(ui).toContain('data-testid="mtf-auto-mode-mismatch"');
    // Initial state must come from the stored auto view, not a hardcoded
    // INTRADAY literal (the old first-paint mismatch).
    expect(ui).toContain('useState<TradePlanModeId>(STORED_AUTO_VIEW.mode)');
  });
});
