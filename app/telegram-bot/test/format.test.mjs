import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmationText, formatAutoStatus, formatBoard, formatHealth, formatStatus } from '../lib/format.mjs';

const board = (row) => ({
  ok: true,
  market: 'CRYPTO',
  mode: 'INTRADAY',
  modeLabel: '15m context → 5m trigger',
  quoteCcy: 'USDT',
  scannedCount: 25,
  asOf: Date.now(),
  liveFeed24x7: { cadenceMs: 2000 },
  counts: { rows: 1, eligible: 0, strong: 1, fired: 1 },
  rows: [row],
  metalsRows: [],
  equitySimRows: [],
  earlyRadar: [],
});

const baseRow = {
  ok: true,
  symbol: 'BTCUSDT',
  tier: 'STRONG',
  superScore: 82,
  side: 'LONG',
  orderSide: 'BUY',
  directionVerified: true,
  directionCertificate: { ok: true },
  plan: {
    entry: 100,
    stopLoss: 95,
    t1: 110,
    t2: 120,
    netRR: { t1: 2, t2: 4 },
  },
  autoEligible: true,
  autoBlockers: [],
  triggerFired: true,
  counterHtf: false,
};

test('formatBoard shows the executed order side when it matches the signal side', () => {
  const text = formatBoard(board(baseRow), { market: 'CRYPTO' });
  assert.match(text, /BTCUSDT/);
  assert.match(text, /LONG/);
  assert.match(text, /order BUY/);
  assert.doesNotMatch(text, /SIDE MISMATCH/);
  assert.match(text, /PAKKA/);
});

test('formatBoard flags a signal/order side mismatch instead of hiding it', () => {
  const text = formatBoard(board({ ...baseRow, orderSide: 'SELL' }), { market: 'CRYPTO' });
  assert.match(text, /⚠️order SELL/);
  assert.match(text, /SIDE MISMATCH/);
});

test('formatBoard marks blocked rows with the server blocker text', () => {
  const text = formatBoard(board({
    ...baseRow,
    autoEligible: false,
    autoBlockers: ['counter-HTF setup'],
    counterHtf: true,
    htfBias: 'BEARISH',
  }), { market: 'CRYPTO' });
  assert.match(text, /AUTO ✗ counter-HTF setup/);
  assert.match(text, /HTF BEARISH/);
});

test('formatBoard gives a duplicated metal one home in GOLD/SILVER', () => {
  const xag = {
    ...baseRow,
    symbol: 'XAG',
    side: 'SHORT',
    orderSide: 'SELL',
    tier: 'WATCH',
    market: 'FUTURES',
  };
  const data = board(baseRow);
  data.rows = [baseRow, xag];
  data.metalsRows = [xag];

  const text = formatBoard(data, { market: 'CRYPTO' });
  const [mainPart, metalPart] = text.split('<b>GOLD / SILVER (USDT)</b>');
  assert.doesNotMatch(mainPart, /XAG/);
  assert.match(metalPart, /XAG/);
  assert.equal((text.match(/XAG/g) || []).length, 1);
  assert.match(text, /shown 2 · auto-ready/);
  assert.match(text, /signal side and executed order side shown/);
});

test('formatAutoStatus renders per-desk readiness objects honestly', () => {
  const text = formatAutoStatus({
    ok: true,
    enabled: false,
    executionMode: 'live',
    mode: 'INTRADAY',
    minScore: 75,
    effectiveWalletINR: 1000,
    riskCaps: { effectiveRiskINR: 10, effectiveWalletDeployPct: 100, effectiveLeverage: 10 },
    maxTradesPerDay: 3,
    maxOpenPositions: 2,
    dayCount: 1,
    maxNotionalPerTradeINR: 10000,
    wallet95Deployment: { buyingPowerINR: 5000 },
    desks: { crypto: true, india: true },
    coindcxConnected: true,
    siteLiveActive: true,
    killSwitch: false,
    deskReady: { crypto: { ready: true }, india: { ready: false } },
    deskArmable: {
      crypto: { armable: true },
      india: { armable: false, why: 'India LIVE mode is not armed' },
    },
    deepMonitor: { activeCount: 0, tp1LockedCount: 0, reversalAlertCount: 0, directionBlockedCount: 0 },
  });

  assert.match(text, /armable CRYPTO ✅ \/ INDIA ❌/);
  assert.match(text, /INDIA: India LIVE mode is not armed/);
  assert.doesNotMatch(text, /armable —/);
});

test('confirmation text reports the configured expiry, not a hardcoded value', () => {
  const text = confirmationText('on', {
    enabled: false,
    executionMode: 'live',
    effectiveWalletINR: 1000,
    riskCaps: { effectiveRiskINR: 10, effectiveWalletDeployPct: 100, effectiveLeverage: 10 },
  }, { ttlMs: 15000 });

  assert.match(text, /Confirmation 15 seconds me expire/);
});

test('formatHealth reads live feed and ML shapes without inventing a status', () => {
  const text = formatHealth({
    health: {
      ok: true,
      version: '21.25.3',
      uptime: 10,
      botAlive: true,
      providers: ['groq'],
      feeds: {
        crypto: {
          rt: {
            enabled: true,
            connected: false,
            healthy: false,
            domains: { fut: 0, glob: 0 },
            spotWs: { healthy: true, freshMarkets: 782, markets: 972 },
          },
        },
        us: {},
        in: {},
      },
      agents: { crypto: { running: true }, india: { running: true } },
      ml: { engine: { status: 'healthy' }, service: { reachable: false } },
      selfheal: {},
    },
    opHealth: null,
    ping: { pid: 123 },
    errors: [],
  });

  assert.match(text, /Feeds: crypto ✅ \(spot WS 782\/972\) · RT ⚪ idle · US — · IN —/);
  assert.match(text, /ML: engine ✅ · service ❌/);
});

test('formatStatus never prints credentials', () => {
  const text = formatStatus({
    health: {
      ok: true,
      version: '21.25.3',
      uptime: 10,
      botAlive: true,
      feeds: { crypto: { up: true }, us: { up: true }, in: { up: true } },
    },
    auto: {
      enabled: false,
      executionMode: 'paper',
      riskCaps: { effectiveRiskINR: 100, effectiveWalletDeployPct: 100, effectiveLeverage: 5 },
      effectiveWalletINR: 10000,
      maxTradesPerDay: 3,
    },
    positions: {
      positions: [],
      stats: { realizedPnlINR: 0, simRealizedPnlINR: 0 },
    },
    paper: { stats: { openCount: 0, dayNetPnl: 0, totalNetPnl: 0 } },
    push: { healthy: true, delivery: { sent24h: 1, failed24h: 0 } },
    ping: { pong: true, v: '21.25.3', up: 10, latencyMs: 2 },
    errors: [],
  });

  assert.match(text, /SMARTAI STATUS/);
  assert.doesNotMatch(text, /API_TOKEN|TG_TOKEN|Bearer /);
});
