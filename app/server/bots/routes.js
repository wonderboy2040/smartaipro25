// ============================================================
// server/bots/routes.js — Jev Bot Lab v20.8.1
// ------------------------------------------------------------
// Plan §13 Phase 9 dashboard endpoints + §4 Phase 0 smoke:
//   GET  /api/bots/status        per-bot cards data (mode, arms,
//                                equity, P&L, heartbeats, kill state)
//   GET  /api/bots/events        decision stream (append-only log)
//   GET  /api/bots/stream        SSE: status + decision deltas
//   POST /api/bots/stop/:bot     kill switch ON  (UI button)
//   POST /api/bots/start/:bot    kill switch OFF
//   POST /api/bots/arm/:bot      set decider arm (rules|gated|jev|auto)
//   GET  /api/bots/smoke         Phase 0 smoke results (cached 10m)
//   POST /api/bots/backtest      run multi-arm harness on demand (bounded)
//   POST /api/bots/tick          manual cycle trigger (paper)
// v20.8.1: SSE per-connection event CURSOR (the old stream pushed
// events exactly once at connect — the decision stream froze at page
// load), real backpressure inside send(), res.on('close') teardown,
// unref'd interval, connection cap, /tick single-flight, /backtest
// bars cap + pWin persistence, /smoke in-flight dedupe, 2s status
// cache, absolute stateDir default (botRunner.js).
// v21.14.0 (Laya removal): arms sirf rules|gated|jev|auto — laya/
// consensus arms + autolink endpoints permanently removed.
// ============================================================
import { BotRunner, botsEnabled, STRATEGIES, runArmsBacktest } from './botRunner.js';
import { loadBotState, saveBotState, setKillSwitch, killSwitchActive as _killSwitchActive } from './botState.js';
import { smokeAll } from './smoke.js';
import { buildProviders, providerHealth } from './aiProviders.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/bots');
const SSE_MAX_CLIENTS = 8;          // bounded subscribers (sseCap convention)
const SSE_BACKPRESSURE_BYTES = 1 << 20;
// v21.2.0: allowed arms — UI dropdown isi se render hota hai; provider
// availability 409 ke through enforce hoti hai. v21.14: laya/consensus
// removed (single-provider world — consensus ke liye do chahiye the).
const ARMS_ALLOWED = ['rules', 'gated', 'jev', 'auto'];

let _runner = null;

/** v21.1.0 (Phase-3): PEEK — runner banao NAHI, sirf existing return.
 *  healthMonitor ka /api/health snapshot isse use karta hai: getBotRunner()
 *  call karta to singleton null-candleProvider ke saath ban jata aur index.js
 *  ki asli wiring (candleProvider/ai providers) hamesha ke liye ignore ho jaati. */
export function peekBotRunner() { return _runner; }
let _smokeCache = { at: 0, result: null };
let _smokeInFlight = null;
let _tickInFlight = false;
let _statusCache = { at: 0, data: null };

export function getBotRunner(opts = {}) {
  if (!_runner) {
    const env = opts.env || process.env;
    const stateDir = opts.stateDir || env.BOT_STATE_DIR || DEFAULT_STATE_DIR;
    // v21.14: provider REGISTRY — sirf jev (TYPESAFE_API_KEY). Purana
    // opts.jev override (tests) ai.jev ko replace karta hai.
    const providers = buildProviders(env, { stateDir });
    if (opts.jev !== undefined) providers.jev = opts.jev;
    _runner = new BotRunner({
      stateDir,
      env,
      candleProvider: opts.candleProvider || null,
      markPriceProvider: opts.markPriceProvider || null,
      ai: providers,
      telegram: { enabled: false, env: null, ...opts.telegram },
    });
  }
  return _runner;
}

export function registerBotRoutes(app, opts = {}) {
  const runner = getBotRunner(opts);

  // v20.8.1 FIX (H1 — the lab was a static mock): the scheduler. Ticks
  // every 60s (idempotent per bar via late_decision + attempt state),
  // settles open paper positions against live marks. unref'd.
  runner.startScheduler();

  const statusNow = () => {
    if (_statusCache.data && Date.now() - _statusCache.at < 2000) return _statusCache.data;
    _statusCache = { at: Date.now(), data: runner.status() };
    return _statusCache.data;
  };

  app.get('/api/bots/status', (_req, res) => {
    res.json(statusNow());
  });

  app.get('/api/bots/events', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ events: runner.events(limit) });
  });

  let sseClients = 0;
  app.get('/api/bots/stream', (req, res) => {
    if (sseClients >= SSE_MAX_CLIENTS) return res.status(503).json({ error: 'bot stream client cap reached' });
    sseClients++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    // v20.8.1 FIX (H3): teardown on BOTH ends — req 'close' alone left a
    // half-open client's 5s interval (sync disk reads) alive forever.
    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(iv);
      sseClients = Math.max(0, sseClients - 1);
    };
    req.on('close', teardown);
    res.on('close', teardown);
    const send = (event, data) => {
      if (closed) return false;
      // v20.8.1 FIX (H2): REAL backpressure — checked per write, inside
      // send(); a slow client's frame is dropped instead of buffering
      // unboundedly (the old check ran once at setup and did nothing).
      try {
        if (res.socket?._writableState?.writableLength > SSE_BACKPRESSURE_BYTES) return false;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch { teardown(); return false; }
    };
    // per-connection event cursor: push the delta every 5s so the
    // decision stream stays live after connect (v20.8.1 H1 fix — the
    // old stream sent events exactly once at connect).
    // v20.8.2 FIX (L — cursor edge cases): (a) strict '>' comparison
    // permanently DROPPED events stamped in the same millisecond as
    // the last-sent event (one tick bursts several events at one ms);
    // the filter is now inclusive '>=' and the CLIENT dedupes.
    // (b) the old slice(-60) on delta frames silently skipped events
    // when >60 accumulated between pushes — deltas now send everything
    // new (bounded by the 500-event read window). (c) delta reads use
    // a 500-event window so a burst between pushes can't fall out of
    // the read before being sent.
    let cursor = ''; // last event 'at' seen by this client
    const pushEvents = () => {
      const evs = cursor ? runner.events(500) : runner.events(120);
      const fresh = cursor ? evs.filter(e => String(e.at) >= cursor) : evs.slice(-60);
      if (fresh.length) {
        cursor = String(fresh[fresh.length - 1].at);
        send('events', { events: fresh });
      }
    };
    send('status', statusNow());
    pushEvents();
    const iv = setInterval(() => {
      if (closed) return;
      send('status', statusNow());
      pushEvents();
    }, 5000);
    if (typeof iv.unref === 'function') iv.unref();
  });

  app.post('/api/bots/stop/:bot', (req, res) => {
    const { bot } = req.params;
    if (!STRATEGIES[bot]) return res.status(404).json({ error: 'unknown bot' });
    // v20.8.2 FIX (L): note length bounded (was unbounded inside the
    // json body cap) — it lands in a kill-switch file on disk.
    const note = String(req.body?.note || 'ui').slice(0, 200);
    const on = setKillSwitch(runner.stateDir, bot, true, note);
    res.json({ bot, killSwitch: on });
  });

  app.post('/api/bots/start/:bot', (req, res) => {
    const { bot } = req.params;
    if (!STRATEGIES[bot]) return res.status(404).json({ error: 'unknown bot' });
    const on = setKillSwitch(runner.stateDir, bot, false);
    res.json({ bot, killSwitch: on });
  });

  app.post('/api/bots/arm/:bot', (req, res) => {
    const { bot } = req.params;
    const arm = String(req.body?.arm || '');
    if (!STRATEGIES[bot]) return res.status(404).json({ error: 'unknown bot' });
    if (!ARMS_ALLOWED.includes(arm)) return res.status(400).json({ error: `arm must be ${ARMS_ALLOWED.join('|')}` });
    // v21.2.0: provider availability ENFORCED. Requested arm ka provider
    // configured nahi to 409 provider_unavailable — UI clear message
    // dikhaata hai; silently accept karke phir arm_fallback events se
    // bharna (silent behaviour change) kabhi nahi.
    const ai = runner.ai || { jev: null };
    if (arm === 'jev' && !ai.jev) {
      return res.status(409).json({ error: 'provider_unavailable', provider: 'jev', hint: 'TYPESAFE_API_KEY .env me set karo' });
    }
    if (arm === 'auto' && !ai.jev) {
      return res.status(409).json({ error: 'provider_unavailable', provider: 'ai', hint: 'auto ke liye kam se kam ek provider chahiye' });
    }
    const st = loadBotState(runner.stateDir, bot) || {};
    saveBotState(runner.stateDir, bot, { ...st, arm });
    res.json({ bot, arm });
  });

  // v21.2.0: per-provider AI health — reachable/breaker/p50/p95/
  // rejects/model/urlHost. Auth ke andar.
  app.get('/api/bots/ai/health', (_req, res) => {
    res.json(providerHealth(runner.ai || {}));
  });

  // v20.8.1 FIX (M): single-flight — concurrent POSTs piled up
  // sequential awaits over bots (12s Dhan timeouts each).
  app.post('/api/bots/tick', async (_req, res) => {
    if (_tickInFlight) return res.status(429).json({ error: 'tick already running' });
    _tickInFlight = true;
    try {
      const out = {};
      for (const botId of botsEnabled(runner.env)) {
        try { out[botId] = await runner.tick(botId); } catch (e) { out[botId] = { error: String(e?.message || e) }; }
      }
      res.json({ mode: runner.cfg.mode, ticks: out });
    } finally {
      _tickInFlight = false;
    }
  });

  // v20.8.1 FIX (M): in-flight dedupe — concurrent first requests each
  // ran smokeAll (real network calls incl. a paid Jev ping).
  app.get('/api/bots/smoke', async (_req, res) => {
    if (_smokeCache.result && Date.now() - _smokeCache.at < 10 * 60000) {
      return res.json({ cached: true, ..._smokeCache.result });
    }
    if (_smokeInFlight) {
      try { return res.json({ cached: true, ...(await _smokeInFlight) }); } catch { /* fall through */ }
    }
    _smokeInFlight = smokeAll();
    try {
      const result = await _smokeInFlight;
      _smokeCache = { at: Date.now(), result };
      res.json({ cached: false, ...result });
    } catch (e) {
      // v20.8.2 FIX (M): no catch on the await — a rejected smokeAll leg
      // propagated as a sync throw inside an async handler (Express 4
      // hangs the request) instead of an honest 500.
      res.status(500).json({ error: String(e?.message || e) });
    } finally {
      _smokeInFlight = null;
    }
  });

  // Bounded backtest runner — same engine the CLI script uses.
  app.post('/api/bots/backtest', async (req, res) => {
    const botId = String(req.body?.bot || 'orb_crypto_utc');
    if (!STRATEGIES[botId]) return res.status(404).json({ error: 'unknown bot' });
    const bars = req.body?.bars;
    // v20.8.1 FIX (L): upper bound — the old route ran unbounded arrays
    // (3 full arms each) on the event loop.
    if (!Array.isArray(bars) || bars.length < 60) {
      return res.status(400).json({ error: 'bars[] (>=60) required — fetch via candle store or upload' });
    }
    if (bars.length > 20000) {
      return res.status(400).json({ error: `bars too large (${bars.length} > 20000) — use the CLI for deep history` });
    }
    try {
      const strategy = STRATEGIES[botId].factory();
      // v21.14: runArmsBacktest — jev ho to jev arm bhi (rules/gated
      // hamesha). Purana runThreeArmBacktest (jev-only) wrapper me hai.
      const ai = runner.ai || { jev: null };
      const arms = await runArmsBacktest({
        strategy, bars, symbol: req.body?.symbol || botId,
        providers: ai, primary: runner.aiCfg?.primary || 'jev',
      });
      const summary = {};
      for (const [arm, r] of Object.entries(arms)) summary[arm] = { metrics: r.metrics, pass: r.pass, meta: { ambiguousShare: r.meta.ambiguousShare, decisions: r.meta.decisions } };
      // v20.8.1 FIX (M): persist pWin into bot state — the fee gate's
      // "p_win from BACKTEST, never Jev" ran on a hardcoded 0.35
      // placeholder because nothing ever wrote backtest results.
      // v20.9.0 (B3 — honest pWin): PER-ARM OUT-OF-SAMPLE pWin ab
      // persist hota hai (metrics.halves.test ka winRate + n) —
      // validatedPWin() isi pe chalta hai (Wilson LB, n>=30 bar).
      // Legacy whole-period pWin display-compat ke liye rakha gaya.
      const gated = arms.gated || arms.rules;
      const armsPersist = {};
      for (const [armName, r] of Object.entries(arms)) {
        const test = r?.metrics?.halves?.test;
        armsPersist[armName] = {
          pWinOos: Number.isFinite(Number(test?.winRate)) ? Number(test.winRate) : null,
          nOos: Number(test?.trades) || 0,
          avgROos: Number.isFinite(Number(test?.avgR)) ? Number(test.avgR) : null,
        };
      }
      if (gated?.metrics?.winRate != null) {
        const st = loadBotState(runner.stateDir, botId) || {};
        saveBotState(runner.stateDir, botId, {
          ...st,
          backtest: {
            pWin: gated.metrics.winRate, trades: gated.metrics.trades, at: new Date().toISOString(),
            arms: armsPersist,
          },
        });
      }
      res.json({ bot: botId, arms: summary });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return runner;
}
