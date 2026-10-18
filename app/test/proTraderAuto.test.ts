// ============================================================
//  v18.6 PRO TRADER AUTO (SAPTA) — engine logic tests
//  Gates: AI >= 75, conf >= 65, verified >= 70 (v20.8.5: 90 → 70 —
//  SVA weighted scoring realistically 80-88 tak pahunchti hai; 90
//  SAPTA ko effectively DEAD rakhta tha) + SVA CONFIRM + finalCall ===
//  side. Exits v20.8.5: TP1 partial+BE-lock / TP2 full / SL instant /
//  reversal 2× confirm.
// ============================================================
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// isolate the data dir BEFORE any server import (store.js resolves at import)
process.env.SMARTAI_DATA_DIR = path.join(os.tmpdir(), `pta-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.SMARTAI_DATA_DIR, { recursive: true });

// ---- mocks (hoisted; factories self-contained, koi outer ref nahi) ----
vi.mock('../server/ai/signals.js', () => ({
  getSignals: vi.fn(async (market: string) => ({
    ok: true, market, marketOpen: true,
    signals: [{
      symbol: 'BTC', market, side: 'LONG', grade: 'STRONG', confidence: 70, ltp: 101, executable: true,
      plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
      superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
    }],
  })),
}));
vi.mock('../server/ai/browserAgent.js', () => ({
  browserConnect: vi.fn(async () => ({ connected: false, tabs: {} })),
  browserStatus: vi.fn(() => ({ connected: false, tabs: {}, lastError: null })),
  cxPairUrl: vi.fn((pair: string, product: string = 'futures') =>
    product === 'spot' ? `https://coindcx.com/trade/${pair}` : `https://coindcx.com/futures/${pair}`),
  cxEnsureTradePage: vi.fn(async () => { throw new Error('no browser'); }),
  cxSelectPair: vi.fn(async () => ({ ok: false })),
  cxPlaceOrder: vi.fn(async () => ({ ok: false })),
  cxClosePosition: vi.fn(async () => ({ ok: false })),
  dhanEnsurePage: vi.fn(async () => { throw new Error('no browser'); }),
  dhanSelectScrip: vi.fn(async () => ({ ok: false })),
  dhanPlaceOrder: vi.fn(async () => ({ ok: false })),
}));

const {
  PROTRADER_DEFAULTS, proTraderGate, pickProTraderCandidate, proTraderReversalCheck,
  loadProTraderConfig, updateProTraderConfig, proTraderStart, proTraderStop,
  proTraderStatusView, proTraderTick, indiaMarketOpen,
} = await import('../server/ai/proTraderAuto.js');
const browserAgentMod = await import('../server/ai/browserAgent.js');
const browserStatusMock = vi.mocked(browserAgentMod.browserStatus);

const sig = (over = {}) => ({
  symbol: 'BTC', market: 'CRYPTO', side: 'LONG', grade: 'STRONG', confidence: 70,
  ltp: 100, executable: true,
  plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
  superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
  ...over,
});

describe('v18.6 ProTraderAuto — USER-SPEC gates (75 / 65 / 70)', () => {
  it('pass: AI 80 + conf 70 + verified 92 CONFIRM + finalCall LONG', () => {
    const g = proTraderGate(sig(), PROTRADER_DEFAULTS);
    expect(g.pass).toBe(true);
    expect(g.reasons).toEqual([]);
  });

  it('SHORT side bhi pass hota hai (finalCall SHORT ke saath)', () => {
    const g = proTraderGate(sig({ side: 'SHORT', verify: { score: 93, action: 'CONFIRM', finalCall: 'SHORT' } }), PROTRADER_DEFAULTS);
    expect(g.pass).toBe(true);
  });

  it('verified 69 < 70 pe FAIL (v20.8.5 — 70 = SVA CONFIRM floor + buffer; 90 practically unreachable tha)', () => {
    const g = proTraderGate(sig({ verify: { score: 69, action: 'CONFIRM', finalCall: 'LONG' } }), PROTRADER_DEFAULTS);
    expect(g.pass).toBe(false);
    expect(g.reasons.join(' ')).toContain('verified:69<70');
  });

  it('aiScore 74.9 < 75 pe FAIL', () => {
    const g = proTraderGate(sig({ superIntel: { aiScore: 74.9 } }), PROTRADER_DEFAULTS);
    expect(g.pass).toBe(false);
    expect(g.reasons.join(' ')).toContain('aiScore:74.9<75');
  });

  it('confidence 64 < 65 pe FAIL', () => {
    const g = proTraderGate(sig({ confidence: 64 }), PROTRADER_DEFAULTS);
    expect(g.pass).toBe(false);
    expect(g.reasons.join(' ')).toContain('conf:64<65');
  });

  it('verify.action CAUTION pe FAIL (CONFIRM zaroori)', () => {
    const g = proTraderGate(sig({ verify: { score: 92, action: 'CAUTION', finalCall: 'LONG' } }), PROTRADER_DEFAULTS);
    expect(g.pass).toBe(false);
    expect(g.reasons.join(' ')).toContain('verify:CAUTION');
  });

  it('finalCall signal-side ke against ho to FAIL (misaligned SVA)', () => {
    const g = proTraderGate(sig({ verify: { score: 92, action: 'CONFIRM', finalCall: 'SHORT' } }), PROTRADER_DEFAULTS);
    expect(g.pass).toBe(false);
    expect(g.reasons.join(' ')).toContain('finalCall:SHORT!=LONG');
  });

  it('WATCH grade / FLAT side / no plan sab reject', () => {
    expect(proTraderGate(sig({ grade: 'WATCH' }), PROTRADER_DEFAULTS).pass).toBe(false);
    expect(proTraderGate(sig({ side: 'FLAT', verify: { score: 95, action: 'CONFIRM', finalCall: 'NO_TRADE' } }), PROTRADER_DEFAULTS).pass).toBe(false);
    expect(proTraderGate(sig({ plan: null }), PROTRADER_DEFAULTS).pass).toBe(false);
  });
});

describe('v18.6 ProTraderAuto — candidate picking', () => {
  it('best = highest aiScore among pass; already-open + cooldown skip', () => {
    const signals = [sig({ symbol: 'ETH', superIntel: { aiScore: 82 } }), sig({ symbol: 'BTC' }), sig({ symbol: 'XRP', superIntel: { aiScore: 60 } })];
    const r = pickProTraderCandidate(signals, PROTRADER_DEFAULTS, { existingSymbols: ['BTC'], cooldowns: { ETH: Date.now() + 9_999_999 }, now: Date.now() });
    expect(r.best).toBeNull();
    const r2 = pickProTraderCandidate(signals, PROTRADER_DEFAULTS, { existingSymbols: ['BTC'], cooldowns: {}, now: Date.now() });
    expect(r2.best?.symbol).toBe('ETH');
  });
});

describe('v18.6 ProTraderAuto — reversal exit (CONFIRM SURE policy)', () => {
  const trade = { side: 'LONG', entryPrice: 100, sl: 95 };

  it('SL breach = IMMEDIATE close (1 tick, no double-confirm)', () => {
    const rc = proTraderReversalCheck({ trade, ltp: 94.8, deepSide: 'LONG', deepConf: 80, mtfConsensus: 'BULLISH', mtfAgreePct: 80, cfg: PROTRADER_DEFAULTS });
    expect(rc.immediate).toBe(true);
    expect(rc.wantClose).toBe(true);
    expect(rc.reasons.join(' ')).toContain('SL-hit');
  });

  it('ensemble flip below minReversalConf = NOT a reversal', () => {
    const rc = proTraderReversalCheck({ trade, ltp: 101, deepSide: 'SHORT', deepConf: 60, cfg: PROTRADER_DEFAULTS });
    expect(rc.hit).toBe(false);
  });

  it('single weak MTF flip (agreement < bar) drop ho jata hai', () => {
    const rc = proTraderReversalCheck({ trade, ltp: 101, deepSide: null, deepConf: 0, mtfConsensus: 'BEARISH', mtfAgreePct: 55, cfg: PROTRADER_DEFAULTS });
    expect(rc.hit).toBe(false);
  });

  it('MTF flip + strong agreement = wantClose (hard: 2 reasons threshold logic)', () => {
    const rc = proTraderReversalCheck({ trade, ltp: 101, deepSide: null, deepConf: 0, mtfConsensus: 'BEARISH', mtfAgreePct: 78, cfg: PROTRADER_DEFAULTS });
    expect(rc.hit).toBe(true);
  });

  it('SL + ensemble + MTF teeno = wantClose immediate flag ke bina bhi hard', () => {
    const rc = proTraderReversalCheck({ trade, ltp: 94, deepSide: 'SHORT', deepConf: 72, mtfConsensus: 'BEARISH', mtfAgreePct: 70, cfg: PROTRADER_DEFAULTS });
    expect(rc.reasons.length).toBeGreaterThanOrEqual(2);
    expect(rc.wantClose).toBe(true);
  });

  it('SHORT trade: SL upar + bullish flip', () => {
    const rc = proTraderReversalCheck({ trade: { side: 'SHORT', entryPrice: 100, sl: 105 }, ltp: 105.5, deepSide: 'LONG', deepConf: 70, mtfConsensus: 'BULLISH', mtfAgreePct: 70, cfg: PROTRADER_DEFAULTS });
    expect(rc.immediate).toBe(true);
  });

  it('no ltp = no decision (honest)', () => {
    const rc = proTraderReversalCheck({ trade, ltp: 0, cfg: PROTRADER_DEFAULTS });
    expect(rc.wantClose).toBe(false);
    expect(rc.reasons).toContain('no-ltp');
  });
});

describe('v18.6 ProTraderAuto — config + lifecycle', () => {
  it('defaults = user spec (75/65/70 v20.8.5, off, paper)', () => {
    const cfg = loadProTraderConfig();
    expect(cfg.minAiScore).toBe(75);
    expect(cfg.minConfidence).toBe(65);
    expect(cfg.minVerifiedScore).toBe(70);
    expect(cfg.enabled).toBe(false);
    expect(cfg.mode).toBe('paper');
    // v20.8.5 TP exits
    expect(cfg.tpExitsEnabled).toBe(true);
    expect(cfg.tp1ClosePct).toBe(50);
    expect(cfg.tp1BreakevenLock).toBe(true);
  });

  it('updateProTraderConfig clamps + mode/enabled strip', () => {
    const cfg = updateProTraderConfig({ minAiScore: 999, stakeINR: 50, mode: 'live', enabled: true });
    expect(cfg.minAiScore).toBe(95);
    expect(cfg.stakeINR).toBe(100);
    expect(cfg.mode).toBe('paper');
    expect(cfg.enabled).toBe(false);
  });

  it('LIVE start typed phrase ke bina refuse; PAPER start OK; stop OK', () => {
    const bad = proTraderStart({ mode: 'live', liveConfirmPhrase: 'nope' });
    expect(bad.ok).toBe(false);
    const p = proTraderStart({ mode: 'paper' });
    expect(p.ok).toBe(true);
    const view = proTraderStatusView();
    expect(view.running).toBe(true);
    expect(view.mode).toBe('paper');
    const s = proTraderStop();
    expect(s.ok).toBe(true);
    expect(proTraderStatusView().running).toBe(false);
  });

  it('LIVE start + phrase "LIVE" chal jata hai (kill-switch off)', () => {
    const r = proTraderStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    expect(r.ok).toBe(true);
    proTraderStop();
  });
});

describe('v18.6 ProTraderAuto — tick safety', () => {
  // v18.6.4: monitor LTP chain (liveFeed tick -> CoinDCX tickers -> board)
  // ab deps-injectable hai — tests network pe REAL BTC price fetch karke
  // board ke fake ltp ko bypass nahi karte (hermetic).
  const _LTP_STUB = { getTick: () => null, fetchCoinDcxTickers: async () => [], fetchFuturesPrices: async () => [] }; // v19.0: futures LTP stub (deps-injected — no real network in tests)

  it('idle tick when disabled; kill-switch tick skips trades', async () => {
    proTraderStop();
    const r1 = await proTraderTick(_LTP_STUB, null);
    expect(r1.idle).toBe(true);

    // kill-switch ON → no scan/entry, returns killed
    // (paper start use karte hain — LIVE start khud kill-switch pe refuse ho jata hai)
    const { saveJSON } = await import('../server/lib/store.js');
    saveJSON('ai-trading-config.json', { killSwitch: true, mode: 'paper' });
    proTraderStart({ mode: 'paper' });
    const r2 = await proTraderTick(_LTP_STUB, null);
    expect(r2.killed).toBe(true);
    saveJSON('ai-trading-config.json', { killSwitch: false, mode: 'paper' });
    proTraderStop();
  });

  it('PAPER mode me qualifying candidate aane pe journal-only trade banta hai (browser clicks NAHI)', async () => {
    // config reset (pehle wale clamp-tests ne minAiScore 95 kar diya hoga)
    updateProTraderConfig({ minAiScore: 75, minConfidence: 65, minVerifiedScore: 90, stakeINR: 500, maxConcurrent: 3, maxTradesPerDay: 6 });
    proTraderStart({ mode: 'paper' });
    const r = await proTraderTick(_LTP_STUB, null);
    expect(r.ok).toBe(true);
    const view = proTraderStatusView();
    expect(view.positions.length).toBe(1);
    expect(view.positions[0].symbol).toBe('BTC');
    expect(view.positions[0].mode).toBe('paper');
    expect(view.candidates[0]?.pass).toBe(true);

    // reversal simulate: LTP girake SL hit + SHORT flip -> immediate close next tick
    const { getSignals } = await import('../server/ai/signals.js');
    vi.mocked(getSignals).mockImplementation(async (market: string) => ({
      ok: true, market, marketOpen: true,
      signals: [{
        symbol: 'BTC', market, side: 'SHORT', grade: 'STRONG', confidence: 72, ltp: 94, executable: true,
        plan: { entry: 95, stopLoss: 99, target1: 88, target2: 84 },
        superIntel: { aiScore: 81 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'SHORT' },
      }],
    }));
    await proTraderTick(_LTP_STUB, null);
    const v2 = proTraderStatusView();
    expect(v2.positions.length).toBe(0);
    // closed trade journal me reversal reason ke saath
    const closedLine = v2.log.find((l) => l.level === 'exit' && l.text.includes('CLOSE BTC'));
    expect(closedLine).toBeTruthy();
    expect(closedLine?.text).toContain('REVERSAL');
    proTraderStop();
  });

  it('indiaMarketOpen sirf NSE window me (weekend band)', () => {
    // wall-clock IST semantics: plain local strings (function treats the
    // Date's wall-clock AS IST)
    const sat = new Date('2026-09-26T11:00:00'); // Saturday
    expect(indiaMarketOpen(sat)).toBe(false);
    const mon = new Date('2026-09-28T11:00:00'); // Monday 11:00
    expect(indiaMarketOpen(mon)).toBe(true);
    const monEarly = new Date('2026-09-28T09:15:00'); // before 9:30 entry window
    expect(indiaMarketOpen(monEarly)).toBe(false);
    const monLate = new Date('2026-09-28T15:30:00');
    expect(indiaMarketOpen(monLate)).toBe(false);
  });

  it('v18.6.2 status view browser CDP fields (host/port/portsTried) pass-through karta hai', () => {
    browserStatusMock.mockReturnValueOnce({
      connected: false, browser: null, host: '127.0.0.1', port: 9222, portsTried: [9222, 9223, 9224, 9225],
      tabs: { coindcx: { found: false, hint: 'AUTOMATION window me coindcx.com/trade tab kholo' } },
      lastError: 'connect fail @127.0.0.1:9222/9223/9224/9225 (connect ECONNREFUSED)',
      hint: 'Start-AutoBrowser.bat chalao',
    });
    const view = proTraderStatusView();
    expect(view.browser.host).toBe('127.0.0.1');
    expect(view.browser.port).toBe(9222);
    expect(view.browser.portsTried).toEqual([9222, 9223, 9224, 9225]);
    expect(view.browser.tabs?.coindcx?.hint).toContain('coindcx.com/trade');
    expect(view.browser.hint).toContain('Start-AutoBrowser.bat');
  });
});
