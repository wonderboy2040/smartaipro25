// ============================================================
// test/v2121FuturesInrMarginAutoFix.test.ts — v21.21.0
// ------------------------------------------------------------
// Regression suite for the user's reported CoinDCX Futures INR Wallet &
// Auto-Trade `[400] Insufficient funds` bug:
//   "futures wallet me rehne tho fund nhi hai bol raha hai auto trade ke
//    liye isko fix kardo"
//   Screenshot 1: FUTURES MARGIN (USDT): 0, FUTURES MARGIN (INR): ₹1,163.93,
//                 TOTAL EQUITY (₹): ₹1,164, USD/₹ 94.95
//   Screenshot 2: ⛔ SOL LIVE order failed: CoinDCX futures order failed:
//                 [400] Insufficient funds
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveFuturesWalletMargin,
  futuresOrderBody,
  executeMtfDualLiveOrder,
} from '../server/ai/futures.js';
import { ApiFuturesPort } from '../server/exec/port.js';

describe('v21.21.0 — CoinDCX Futures INR Wallet & Auto-Trade Insufficient Funds Fix', () => {
  it('1) resolveFuturesWalletMargin detects INR futures margin when USDT is 0 (exact screenshot wallet: ₹1,163.93 @ 94.95)', () => {
    const wallets = [
      { currency_short_name: 'USDT', balance: '0', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      { currency_short_name: 'INR', balance: '1163.93', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
    ];
    const m = resolveFuturesWalletMargin(wallets, 94.95);
    expect(m.marginCurrency).toBe('INR');
    expect(m.freeUSDT).toBe(0);
    expect(m.freeINR).toBeCloseTo(1163.93, 2);
    expect(m.freeINRAsUSDT).toBeCloseTo(12.26, 2);
    expect(m.primaryFreeUSDT).toBeCloseTo(12.26, 2);
    expect(m.combinedFreeUSDT).toBeCloseTo(12.26, 2);
  });

  it('2) resolveFuturesWalletMargin prefers USDT when USDT futures balance dominates', () => {
    const wallets = [
      { currency_short_name: 'USDT', balance: '45.5', locked_balance: '0' },
      { currency_short_name: 'INR', balance: '100', locked_balance: '0' },
    ];
    const m = resolveFuturesWalletMargin(wallets, 95);
    expect(m.marginCurrency).toBe('USDT');
    expect(m.primaryFreeUSDT).toBeCloseTo(45.5, 2);
    expect(m.combinedFreeUSDT).toBeCloseTo(45.5 + 100 / 95, 1);
  });

  it('3) futuresOrderBody includes margin_currency_short_name when marginCurrency is provided, and omits it when not provided', () => {
    const withInr = futuresOrderBody({
      pair: 'B-SOL_USDT',
      side: 'sell',
      qty: 0.08,
      leverage: 10,
      marginCurrency: 'INR',
    });
    expect(withInr.order.margin_currency_short_name).toBe('INR');
    expect(withInr.order.pair).toBe('B-SOL_USDT');
    expect(withInr.order.total_quantity).toBe(0.08);

    const legacy = futuresOrderBody({
      pair: 'B-SOL_USDT',
      side: 'sell',
      qty: 0.08,
      leverage: 10,
    });
    expect(legacy.order).not.toHaveProperty('margin_currency_short_name');
  });

  it('4) ApiFuturesPort.getEquity combines USDT (0) + INR (₹1,163.93) futures wallet so Agent never sees 0 free margin', async () => {
    const port = new ApiFuturesPort({
      futuresMod: {
        fetchFuturesWallets: async () => [
          { currency: 'USDT', free: 0, locked: 0, total: 0 },
          { currency: 'INR', free: 1163.93, locked: 0, total: 1163.93 },
        ],
        fetchUsdInr: async () => 94.95,
      },
    });
    const eq = await port.getEquity();
    expect(eq.freeUSDT).toBeCloseTo(12.26, 2);
    expect(eq.totalUSDT).toBeCloseTo(12.26, 2);
  });

  describe('5) executeMtfDualLiveOrder — INR wallet sizing + 4-rung Insufficient-funds retry ladder', () => {
    const origFetch = global.fetch;
    const origKey = process.env.COINDCX_KEY;
    const origSec = process.env.COINDCX_SECRET;
    const dataDir = process.env.SMARTAI_DATA_DIR || path.join(process.cwd(), 'server', 'data');
    const journalPath = path.join(dataDir, 'ai-trading-journal.json');
    const cfgPath = path.join(dataDir, 'ai-trading-config.json');
    const mcpPath = path.join(dataDir, 'mcp-coindcx.json');
    let savedJournal: string | null = null;
    let savedCfg: string | null = null;
    let savedMcp: string | null = null;

    beforeEach(() => {
      savedJournal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : null;
      savedCfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
      savedMcp = fs.existsSync(mcpPath) ? fs.readFileSync(mcpPath, 'utf8') : null;
      process.env.COINDCX_KEY = 'test-key-v2121';
      process.env.COINDCX_SECRET = 'test-secret-v2121';
    });

    afterEach(() => {
      global.fetch = origFetch;
      if (origKey === undefined) delete process.env.COINDCX_KEY;
      else process.env.COINDCX_KEY = origKey;
      if (origSec === undefined) delete process.env.COINDCX_SECRET;
      else process.env.COINDCX_SECRET = origSec;
      if (savedJournal === null) { try { fs.unlinkSync(journalPath); } catch { /* ignore */ } }
      else fs.writeFileSync(journalPath, savedJournal);
      if (savedCfg === null) { try { fs.unlinkSync(cfgPath); } catch { /* ignore */ } }
      else fs.writeFileSync(cfgPath, savedCfg);
      if (savedMcp === null) { try { fs.unlinkSync(mcpPath); } catch { /* ignore */ } }
      else fs.writeFileSync(mcpPath, savedMcp);
    });

    it('auto-fits oversized marginUSDT (15.80 USDT from ₹15k paper cap) into ₹1,163.93 INR wallet and sends margin_currency_short_name="INR"', async () => {
      const orderCalls: any[] = [];
      global.fetch = vi.fn(async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/derivatives/futures/wallets')) {
          return new Response(JSON.stringify([
            { currency_short_name: 'USDT', balance: '0', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
            { currency_short_name: 'INR', balance: '1163.93', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
          ]), { status: 200 });
        }
        if (u.includes('/derivatives/futures/data/instrument')) {
          return new Response(JSON.stringify({
            instrument: {
              pair: 'B-SOL_USDT',
              status: 'active',
              max_leverage_long: 5,
              max_leverage_short: 5,
              min_quantity: 0.01,
              quantity_increment: 0.01,
              min_notional: 6,
              safety_percentage: 2,
              dynamic_position_leverage_details: [[50000, 25], [25000, 35], [5000, 50]],
            },
          }), { status: 200 });
        }
        if (u.includes('/derivatives/futures/orders/create')) {
          const parsed = JSON.parse(String(init?.body || '{}'));
          orderCalls.push(parsed);
          return new Response(JSON.stringify([{ id: 'ord-inr-sol-1', status: 'open' }]), { status: 200 });
        }
        if (u.includes('/derivatives/futures/positions')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as any;

      const res = await executeMtfDualLiveOrder({
        symbol: 'SOL',
        market: 'FUTURES',
        side: 'SHORT',
        entry: 103.5,
        stopLoss: 104.8,
        t1: 102.2,
        t2: 100.9,
        leverage: 10,
        marginUSDT: 15.80, // ₹1,500 (> ₹1,163.93 wallet!)
      });

      expect(res.ok).toBe(true);
      expect(orderCalls.length).toBe(1);
      expect(orderCalls[0].order.margin_currency_short_name).toBe('INR');
      expect(orderCalls[0].order.pair).toBe('B-SOL_USDT');
      // Notional and total exchange lock must fit comfortably inside ~12.26 USDT (₹1,163.93)
      const sentQty = orderCalls[0].order.total_quantity;
      const sentLev = orderCalls[0].order.leverage;
      const notional = sentQty * 103.5;
      const estExchangeLockUsdt = notional * (1 / sentLev + 0.02 + 0.003);
      expect(estExchangeLockUsdt).toBeLessThanOrEqual(12.26);
      expect(res.filled?.marginCurrency).toBe('INR');
    });

    it('steps down the 4-rung retry ladder when CoinDCX rejects initial qty with [400] Insufficient funds', async () => {
      const orderCalls: any[] = [];
      let callIdx = 0;
      global.fetch = vi.fn(async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/derivatives/futures/wallets')) {
          return new Response(JSON.stringify([
            { currency_short_name: 'USDT', balance: '0', locked_balance: '0' },
            { currency_short_name: 'INR', balance: '1163.93', locked_balance: '0' },
          ]), { status: 200 });
        }
        if (u.includes('/derivatives/futures/data/instrument')) {
          return new Response(JSON.stringify({
            instrument: {
              pair: 'B-NEAR_USDT',
              status: 'active',
              max_leverage_long: 10,
              min_quantity: 1,
              quantity_increment: 1,
              min_notional: 6,
              safety_percentage: 2,
            },
          }), { status: 200 });
        }
        if (u.includes('/derivatives/futures/orders/create')) {
          callIdx++;
          const parsed = JSON.parse(String(init?.body || '{}'));
          orderCalls.push(parsed);
          if (callIdx === 1) {
            return new Response(JSON.stringify({ message: 'Insufficient funds' }), { status: 400 });
          }
          return new Response(JSON.stringify([{ id: 'ord-inr-sol-retry-ok', status: 'open' }]), { status: 200 });
        }
        if (u.includes('/derivatives/futures/positions')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as any;

      const res = await executeMtfDualLiveOrder({
        symbol: 'NEAR',
        market: 'FUTURES',
        side: 'LONG',
        entry: 5.0,
        stopLoss: 4.9,
        t1: 5.1,
        t2: 5.2,
        leverage: 10,
        marginUSDT: 10,
      });

      expect(res.ok).toBe(true);
      expect(orderCalls.length).toBeGreaterThanOrEqual(2);
      expect(res.filled?.orderId).toBe('ord-inr-sol-retry-ok');
    });
  });

  describe('6) mtfAutoTick — caps live marginUSDT to <=72% of wallet and tries next eligible symbol if first is skipped', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-v2121-'));
      process.env.MTF_AUTO_DATA_DIR = tmpDir;
    });
    afterEach(() => {
      delete process.env.MTF_AUTO_DATA_DIR;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('passes wallet-capped marginUSDT and falls through to 2nd/3rd eligible symbol when first is rejected', async () => {
      const mtfAuto = await import('../server/ai/mtfAutoLink.js');
      mtfAuto.__resetMtfAutoForTests();
      mtfAuto.setMtfAutoEnabled(true);
      mtfAuto.updateMtfAutoConfig({
        executionMode: 'live',
        minScore: 75,
        walletAmountINR: 1164,
        maxNotionalPerTradeINR: 15000, // paper default that previously caused $15.80 USDT margin!
        markets: ['CRYPTO'],
      });

      const liveAttempts: Array<{ symbol: string; marginUSDT: number }> = [];
      let paperId = 900;
      const res = await mtfAuto.mtfAutoTick({
        boards: {
          CRYPTO: {
            ok: true,
            market: 'CRYPTO',
            mode: 'INTRADAY',
            holdMin: 45,
            minScore: 75,
            rows: [
              {
                ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m + 5m',
                superScore: 91, tier: 'ELITE', side: 'SHORT', dir: -1,
                triggerFired: true, dualAligned: true, counterTrend: false,
                tfFit: 'OK', grade: 'A', costR: 0.1, holdMin: 45,
                autoEligible: true, autoBlockers: [],
                plan: { entry: 81000, stopLoss: 81800, t1: 80200, t2: 79400 },
              },
              {
                ok: true, symbol: 'SOLUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m + 5m',
                superScore: 86, tier: 'ELITE', side: 'SHORT', dir: -1,
                triggerFired: true, dualAligned: true, counterTrend: false,
                tfFit: 'OK', grade: 'A', costR: 0.1, holdMin: 45,
                autoEligible: true, autoBlockers: [],
                plan: { entry: 103.5, stopLoss: 104.8, t1: 102.2, t2: 100.9 },
              },
              {
                ok: true, symbol: 'NEARUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m + 5m',
                superScore: 84, tier: 'STRONG', side: 'SHORT', dir: -1,
                triggerFired: true, dualAligned: true, counterTrend: false,
                tfFit: 'OK', grade: 'A', costR: 0.1, holdMin: 45,
                autoEligible: true, autoBlockers: [],
                plan: { entry: 5.0, stopLoss: 5.1, t1: 4.9, t2: 4.8 },
              },
            ],
          },
        },
        walletEquityINR: 1164,
        siteLiveActive: true,
        fx: 94.95,
        paper: {
          getPaperSummary: () => ({ open: [] }),
          openPaperTrade: (args: Record<string, unknown>) => {
            if (args.symbol === 'BTC') return { ok: false, error: 'BTC lot rejected' };
            return { ok: true, trade: { id: ++paperId, ...args } };
          },
          closePaperTrade: () => ({ ok: true }),
        },
        liveExecute: async (orderReq: any) => {
          liveAttempts.push({ symbol: orderReq.symbol, marginUSDT: orderReq.marginUSDT });
          return {
            ok: true,
            orderId: `ord-${orderReq.symbol}-1`,
          };
        },
      });

      // Because BTC was skipped, the loop fell through to SOL and opened strictly 1 trade (never 2 trades together)!
      expect(res.opened.length).toBe(1);
      expect(liveAttempts.length).toBe(1);
      expect(liveAttempts[0].symbol).toBe('SOL');
      // Wallet is ₹1,164 @ 94.95 (~$12.26 USDT). 72% cap = ~$8.83 USDT (never $15.80!)
      expect(liveAttempts[0].marginUSDT).toBeLessThanOrEqual((1164 * 0.72) / 94.95 + 0.01);
    });
  });
});
