// ============================================================
// server/ai/telegramPush.js — v10.9 INSTANT TELEGRAM PUSH
// ------------------------------------------------------------
// THE GAP: SL/target hits and fresh STRONG signals reached Telegram
// only when a 60s watcher (server) or the legacy bot's 10-minute
// cron got around to them. A fast crypto move could hit your stop
// and report a minute late — or ten.
//
// THE FIX: a price-driven Telegram sink that polls the SAME
// position view the realtime SSE stream serves (getPositionsWithPnl
// — cached upstream chains, cheap) every 5 seconds while positions
// are open, and pushes the moment a level is TOUCHED:
//
//   ⚡ SL / TP1 / TP2 / liquidation level touch  → instant push
//   ⚡ fresh STRONG-grade board signal            → instant push
//     (30s board read — the board's own 60-90s cache + single-
//      flight keeps the underlying compute unchanged)
//
// The 60s watchers stay as the EXECUTORS (they own the actual
// close + the fill-confirmed message with realized P&L) and the
// legacy bot's 10-min cron becomes a backup heartbeat (it checks
// /api/ai/insta-push/status and only fires when this pipeline is
// stale). Instant push = the early warning; watcher = the truth.
//
// All sends go through ONE shared dedupe map so the 30s sink scan
// and the 60s backup alerter (routes.js) can never double-send.
// ============================================================
import { getPositionsWithPnl, loadConfig } from './coindcxOrders.js';
import { sendTelegramMessage, telegramConfig, telegramDeliveryHealth } from './secrets.js';
import { pairCorrelation } from './correlation.js';
// v10.14 (deep-recheck S4): the India Intraday desk's OPEN paper positions
// get the SAME instant level-touch push the CoinDCX desk has. Import graph
// is acyclic (paperTrading → store/time/engine/journal — none import ai/*).
import { getPaperSummary } from '../intraday/paperTrading.js';
// v10.16 (S2): the user's OWN manual trades ride the same 5s pipeline
// (SL/T1/T2, MANUAL tagged). manualTrades imports store/backup/liveFeed/
// blackScholes/positionConviction — none import telegramPush → acyclic.
import { manualTradesToPositionRows, listManualTrades } from './manualTrades.js';

const TICK_ACTIVE_MS = 5000;   // open positions on the book
const TICK_IDLE_MS = 15000;    // nothing open — watch for agent-opened entries
const TOUCH_COOLDOWN_MS = 30 * 60 * 1000;  // one push per position+level / 30 min
const STRONG_COOLDOWN_MS = 30 * 60 * 1000; // same as the legacy 60s alerter
const SIGNAL_SCAN_EVERY_N_TICKS = 6;        // ~30s at the active cadence
const CORRELATION_BUNDLE_R = 0.75;          // r ≥ this = one move in disguise (#7)

// ---------------- state ----------------
let _timer = null;
let _ticking = false;
let _tickN = 0;
let _deps = null;               // { getSignals, depsForSignals } — injected at registration
let _tgEnv = null;              // v20.3: { token, chatId } from process env — telegramConfig({})
                                // alone resolves SECRETS only, so env-only deployments
                                // silently got the keyless path (zero instant alerts).
const _touchAlerts = new Map(); // "id:kind" → ts
const _strongAlerts = new Map(); // "mkt:sym:side" → ts
const _status = {
  started: false,
  enabled: true,
  startedAt: null,
  lastOkAt: null,     // last successful poll — the pipeline heartbeat
  lastPushAt: null,
  slTpPushes: 0,
  paperPushes: 0,     // v10.14: India-desk paper level-touch pushes
  manualPushes: 0,    // v10.16: user's own manual-trade level-touch pushes
  signalPushes: 0,
  lastError: null,
};

/** Feature flag — AI_INSTANT_PUSH=off reverts to watcher-only alerts. */
export function instantPushEnabled() {
  return String(process.env.AI_INSTANT_PUSH || '').toLowerCase() !== 'off';
}

// ---------------- pure detection (testable) ----------------
/**
 * Which protective levels are being touched RIGHT NOW by OPEN positions.
 * @param {Array} positions rows of getPositionsWithPnl (status 'OPEN')
 * @returns {Array<{id,pair,market,side,kind,level,ltp,unrealizedPnlINR,leverage}>}
 */
export function detectLevelTouches(positions) {
  const out = [];
  for (const p of (Array.isArray(positions) ? positions : [])) {
    if (!p || p.status !== 'OPEN') continue;
    const long = p.side === 'LONG';
    const ltp = Number(p.ltp);
    if (!Number.isFinite(ltp) || ltp <= 0) continue;
    const fin = (v) => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

    const sl = fin(p.sl);
    if (sl != null && (long ? ltp <= sl : ltp >= sl)) {
      out.push(_touch(p, 'SL', sl, ltp));
    }
    const liq = fin(p.liquidation);
    if ((p.leverage || 1) > 1 && liq != null && (long ? ltp <= liq : ltp >= liq)) {
      out.push(_touch(p, 'LIQ', liq, ltp));
    }
    const tp = fin(p.tp);
    if (tp != null && !p.tp1Hit && (long ? ltp >= tp : ltp <= tp)) {
      out.push(_touch(p, 'TP1', tp, ltp));
    }
    const tp2 = fin(p.tp2);
    if (tp2 != null && !p.tp2Hit && (long ? ltp >= tp2 : ltp <= tp2)) {
      out.push(_touch(p, 'TP2', tp2, ltp));
    }
  }
  return out;
}

function _touch(p, kind, level, ltp) {
  return {
    id: p.id, pair: p.pair, market: p.market || null, side: p.side,
    kind, level, ltp,
    unrealizedPnlINR: Number.isFinite(Number(p.unrealizedPnlINR)) ? p.unrealizedPnlINR : null,
    leverage: p.leverage || 1,
    ...(p.paper ? { paper: true } : {}),
    ...(p.manual ? { manual: true } : {}),
  };
}

/** v10.14 (deep-recheck S4): India Intraday desk → CoinDCX position shape.
 *  The paper store's rows (symbol/direction/lastPrice/stopLoss/target1/2,
 *  INR-denominated P&L) map 1:1 onto detectLevelTouches' contract, so the
 *  SAME pure detector + cooldown path serves both desks. Only INDIA-market
 *  paper rows are watched (crypto paper rows live on the intraday-crypto
 *  scanner desk; real CoinDCX crypto is already covered above). */
export function paperTradesToPositionRows(summary) {
  const rows = [];
  for (const t of (Array.isArray(summary?.open) ? summary.open : [])) {
    if (!t || (t.status !== 'OPEN' && t.status !== 'PARTIAL')) continue;
    if (String(t.market || '').toUpperCase() !== 'INDIA') continue;
    rows.push({
      id: `paper:${t.id}`,
      pair: t.label || t.symbol,
      market: 'INDIA',
      side: t.direction === 'SHORT' ? 'SHORT' : 'LONG',
      status: 'OPEN',
      ltp: Number(t.lastPrice),
      sl: t.stopLoss,
      tp: t.target1,
      tp2: t.target2,
      tp1Hit: !!t.t1Hit,
      tp2Hit: false,
      liquidation: null,
      leverage: 1,
      unrealizedPnlINR: t.unrealizedPnl,
      paper: true,
    });
  }
  return rows;
}

/** Cooldown gate — pure. */
export function cooldownOk(map, key, now = Date.now(), cooldownMs = TOUCH_COOLDOWN_MS) {
  const last = map.get(key) || 0;
  return now - last >= cooldownMs;
}

function _curOf(market) {
  return market === 'FUTURES' ? ' USDT' : market === 'GLOBALFUTURES' ? ' USDC ' : ' ₹';
}

function _fmt(v, market) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sym = market === 'FUTURES' ? '' : market === 'GLOBALFUTURES' ? 'USDC ' : '₹';
  const num = market === 'INDIA' || !market || market === 'CRYPTO'
    ? n.toLocaleString('en-IN', { maximumFractionDigits: Math.abs(n) < 1 ? 6 : 2 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return `${sym}${num}${market === 'FUTURES' ? ' USDT' : ''}`;
}

/** Format one level touch as the instant-push message (HTML). */
export function formatLevelTouch(t) {
  const EMOJI = { SL: '🛑', LIQ: '☠️', TP1: '🎯', TP2: '🏆' };
  const LABEL = { SL: 'STOP-LOSS TOUCHED', LIQ: 'LIQUIDATION ZONE', TP1: 'TARGET-1 TOUCHED', TP2: 'TARGET-2 TOUCHED' };
  const pnl = t.unrealizedPnlINR != null ? ` · unrealized ₹${Math.round(t.unrealizedPnlINR).toLocaleString('en-IN')}` : '';
  const lev = t.leverage > 1 ? ` · ${t.leverage}x` : '';
  const paperTag = t.paper ? ' · <b>PAPER</b> (India Intraday desk)' : '';
  const manualTag = t.manual ? ' · ✋ <b>MANUAL</b> (aapka trade)' : '';
  return [
    `⚡${EMOJI[t.kind] || '⚠️'} <b>INSTANT — ${LABEL[t.kind] || 'LEVEL TOUCH'}</b>`,
    `<b>${t.pair || t.id}</b> ${t.side}${lev} · LTP <b>${_fmt(t.ltp, t.market)}</b> vs ${t.kind} ${_fmt(t.level, t.market)}${pnl}${paperTag}${manualTag}`,
    t.manual
      ? '✋ manual conviction monitor zinda hai — thesis FLIP hote hi EXIT NOW push alag se aayega (WHY ke saath).'
      : '🤖 executor watcher ka fill-confirmed message ≤60s me aayega — ye level-touch early warning hai.',
  ].join('\n');
}

/** The STRONG-signal message — EXACTLY the legacy alerter's format
 *  (users see one format, whichever path fires first). */
export function formatStrongSignal(s, mkt) {
  // v20.3: FUTURES/GLOBALFUTURES plans are USDT/USDC-denominated — the
  // hardcoded ₹ mislabeled currency in perp trade alerts. _fmt (the
  // per-market formatter used everywhere else) keeps NSE ₹, crypto ₹
  // and futures USDT honest.
  const desk = mkt === 'INDIA' ? '🇮🇳 NSE' : mkt === 'FUTURES' ? '🛡 B-USDT Perps' : '₿ Crypto';
  return `🤖 <b>STRONG SIGNAL</b> — ${desk} · ${s.symbol} ${s.side}\n` +
    `Confidence ${s.confidence}% · agreement ${Math.round((s.agreement || 0) * 100)}% · ${s.participating}/${s.totalModels} models\n` +
    (s.plan ? `Entry ${_fmt(s.plan.entry, mkt)} · SL ${_fmt(s.plan.stopLoss, mkt)} · T2 ${_fmt(s.plan.target2, mkt)} (R:R 1:${s.plan.rewardRisk})` : '');
}

// ---------------- #7: correlation-aware bundling ----------------
/**
 * Union-find clusters of signals whose pairwise 60d correlation ≥
 * threshold (lookup returns r or null — UNKNOWN, never a fake 0 —
 * unknown pairs stay SEPARATE). Pure: the async lookup is injected.
 * @param {Array} signals STRONG signals from ONE scan pass
 * @param {(a:string,b:string) => Promise<number|null>} lookup
 * @returns {Promise<Array<{signals:Array, rMax:number}>>}
 */
export async function groupCorrelatedSignals(signals, { lookup, threshold = CORRELATION_BUNDLE_R } = {}) {
  const sigs = (Array.isArray(signals) ? signals : []).filter(s => s && s.symbol);
  const parent = new Map(sigs.map(s => [s.symbol, s.symbol]));
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(x, root); // path compression
    return root;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  const pairR = []; // [a, b, r] — every correlated union
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      if (find(sigs[i].symbol) === find(sigs[j].symbol)) continue;
      let r = null;
      try { r = await lookup(sigs[i].symbol, sigs[j].symbol); } catch { r = null; }
      if (r != null && Number.isFinite(r) && r >= threshold) {
        union(sigs[i].symbol, sigs[j].symbol);
        pairR.push([sigs[i].symbol, sigs[j].symbol, r]);
      }
    }
  }
  const clusters = new Map(); // root → signals[]
  for (const s of sigs) {
    const root = find(s.symbol);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(s);
  }
  const rMaxOf = (clusterSignals) => {
    const set = new Set(clusterSignals.map(s => s.symbol));
    let m = 0;
    for (const [a, b, r] of pairR) if (set.has(a) && set.has(b) && r > m) m = r;
    return m;
  };
  return [...clusters.values()].map(cs => ({ signals: cs, rMax: rMaxOf(cs) }));
}

/** A cluster of 2+ correlated STRONG signals as ONE message —
 *  'BTC + ETH breaking out together' is ONE notification, not three. */
export function formatStrongBundle(cluster, mkt, rMax) {
  const head = `🤖 <b>STRONG SIGNALS — ${cluster.length} correlated moves</b> ${mkt === 'INDIA' ? '🇮🇳' : '₿'} <i>(60d r ≥ ${Math.round(rMax * 100)}% — ek hi trade hai, diversify ka dhyan)</i>`;
  const rows = cluster.map(s =>
    `• <b>${s.symbol}</b> ${s.side} · conf ${s.confidence}% · ${s.participating}/${s.totalModels} models` +
    (s.plan ? `\n  Entry ₹${s.plan.entry} · SL ₹${s.plan.stopLoss} · T2 ₹${s.plan.target2}` : ''));
  return [head, ...rows].join('\n');
}

// ---------------- shared send path ----------------
/** Failed-send retry hold — short, so a transient Telegram blip
 *  re-attempts on the next sink tick instead of suppressing the alert
 *  for the FULL cooldown window (v10.18 deep-recheck #3: the old
 *  arm-before-send lost the EXIT-NOW/SL/TP push for 30 min on one
 *  5-second network hiccup). */
const SEND_FAIL_RETRY_MS = 30_000;

/** Dedupe + send. @returns {Promise<boolean>} true when pushed. */
async function _pushIfFresh(map, key, text, cooldownMs, send) {
  if (!cooldownOk(map, key, Date.now(), cooldownMs)) return false;
  // RESERVE the key with a timestamp that expires after the failure-retry
  // window (blocks concurrent ticks from double-sending), then arm the
  // FULL cooldown only once the send actually succeeded.
  map.set(key, Date.now() - cooldownMs + SEND_FAIL_RETRY_MS);
  // prune so the maps can't grow unbounded (same hygiene as routes.js)
  if (map.size > 200) {
    const cutoff = Date.now() - cooldownMs;
    for (const [k, ts] of map) if (ts < cutoff) map.delete(k);
  }
  const r = await send(text);
  if (r?.ok) { map.set(key, Date.now()); return true; }
  return false;
}

// ---------------- shared STRONG scan (sink + backup, one code path) ----------------
/**
 * Scan ONE market's board for fresh STRONG signals and push them —
 * correlated clusters (r ≥ 0.75, #7) go out as ONE bundled message
 * so "BTC + ETH together" pings once, not twice. Used by BOTH the
 * 30s instant sink and the 60s backup alerter through the SAME
 * dedupe map — whichever sees it first wins, the other no-ops.
 * @returns {Promise<number>} pushes sent
 */
async function _scanAndPushStrongs(mkt, { getSignals, depsForSignals }, send) {
  const board = await getSignals(mkt, depsForSignals(), { limit: 5 }).catch(() => null);
  const strongs = (board?.signals || []).filter(s => s.grade === 'STRONG');
  const fresh = strongs.filter(s => cooldownOk(_strongAlerts, `${mkt}:${s.symbol}:${s.side}`));
  if (!fresh.length) return 0;

  // #7 bundling — crypto bases are what pairCorrelation knows; INDIA
  // symbols stay per-signal (no honest r without a mapping).
  if (mkt === 'CRYPTO' && fresh.length >= 2) {
    const clusters = await groupCorrelatedSignals(fresh, { lookup: pairCorrelation });
    let pushed = 0;
    for (const { signals: cluster, rMax } of clusters) {
      const keys = cluster.map(s => `${mkt}:${s.symbol}:${s.side}`);
      if (cluster.length >= 2) {
        // mark EVERY member first — a later singleton must not re-ping
        const now = Date.now();
        for (const k of keys) _strongAlerts.set(k, now);
        const r = await send(formatStrongBundle(cluster, mkt, rMax));
        if (r?.ok) pushed++;
      } else {
        if (await _pushIfFresh(_strongAlerts, keys[0], formatStrongSignal(cluster[0], mkt), STRONG_COOLDOWN_MS, send)) pushed++;
      }
    }
    return pushed;
  }

  let pushed = 0;
  for (const s of fresh) {
    if (await _pushIfFresh(_strongAlerts, `${mkt}:${s.symbol}:${s.side}`, formatStrongSignal(s, mkt), STRONG_COOLDOWN_MS, send)) pushed++;
  }
  return pushed;
}

// ---------------- the sink loop ----------------
// v20.2 FAST-PATH EXECUTOR: when a level touch is detected on a live
// SPOT position, the sink fires the position watcher IMMEDIATELY
// (injected from routes.js — no import cycle) instead of letting the
// price sit through the SL for up to 60s. Futures already have
// exchange-native TP/SL (create_tpsl) and their own watcher; India
// paper/manual desks keep their own monitors — this path is for the
// spot book, which had NO exchange-native stop.
let _fastWatchSpot = null;
let _fastWatchLastAt = 0;
const FAST_WATCH_MIN_GAP_MS = 10_000; // watchPositions is single-flight; this is belt-and-braces

async function _maybeFastWatchSpot(touches) {
  if (typeof _fastWatchSpot !== 'function') return;
  const urgent = (touches || []).filter(t => t && (t.market || '').toUpperCase() === 'CRYPTO');
  if (!urgent.length) return;
  const now = Date.now();
  if (now - _fastWatchLastAt < FAST_WATCH_MIN_GAP_MS) return;
  _fastWatchLastAt = now;
  try {
    const closures = await _fastWatchSpot();
    if (Array.isArray(closures) && closures.length) {
      console.log(`[insta-push] fast-path closed ${closures.length} spot position(s) on level touch: ${closures.map(c => c.pair).join(', ')}`);
    }
  } catch (e) {
    console.warn('[insta-push] fast-watch failed (60s watcher remains the backstop)', e?.message || e);
  }
}

async function _tick() {
  if (_ticking) return;
  _ticking = true;
  let nextDelay = TICK_IDLE_MS;
  try {
    // v20.3: resolve with the env keys the routes pass in (TG_TOKEN /
    // TG_CHAT_ID). Previously telegramConfig({}) saw secrets ONLY — an
    // env-configured deployment got a silent "keyless" outage: 5s level
    // pushes, STRONG scans and the backup alerter all no-op'd while
    // watcher close messages (which DO pass env) kept arriving.
    const cfgTG = telegramConfig(_tgEnv || {});
    // v20.2 RESTRUCTURE: the position sweep + level-touch detection +
    // fast-path executor now run even when Telegram keys are ABSENT —
    // an SL close must never depend on alert keys. Without keys the
    // sink still parks cheaply when nothing is open; with open
    // positions it stays at the 5s cadence purely for the fast path.
    const send = cfgTG
      ? (text) => sendTelegramMessage(text, { token: cfgTG.token, chatId: cfgTG.chatId })
      : null;

    // --- 1) SL/TP/LIQ level touches (the 5s price-driven win) ---
    const view = await getPositionsWithPnl();
    const positions = Array.isArray(view?.positions) ? view.positions : [];
    const open = positions.filter(p => p.status === 'OPEN');
    const touches = detectLevelTouches(open);
    // v20.2: a touched level on a live SPOT position = close it NOW (the
    // 60s watcher stays the backstop; this is the 5s front line).
    await _maybeFastWatchSpot(touches);
    if (send) {
      for (const t of touches) {
        const pushed = await _pushIfFresh(_touchAlerts, `${t.id}:${t.kind}`, formatLevelTouch(t), TOUCH_COOLDOWN_MS, send);
        if (pushed) {
          _status.slTpPushes++;
          _status.lastPushAt = Date.now();
          console.log(`[insta-push] ${t.kind} touch ${t.pair} @ ${t.ltp}`);
        }
      }
    }
    nextDelay = open.length > 0 ? TICK_ACTIVE_MS : TICK_IDLE_MS;

    if (!cfgTG) {
      // No keys → no alert paths; keep the 5s cadence only while the
      // fast-path executor has something to guard.
      _status.lastOkAt = Date.now();
      _status.lastError = null;
      nextDelay = open.length > 0 ? TICK_ACTIVE_MS : 60_000;
      return;
    }

    // --- 1b) v10.14 (deep-recheck S4): India Intraday desk paper positions
    //     get the SAME instant level-touch push (SL/T1/T2, INR P&L, PAPER
    //     tagged). Paper-store failures are contained — the CoinDCX desk
    //     keeps flowing even if the intraday store is unavailable.
    try {
      const paperOpen = paperTradesToPositionRows(getPaperSummary());
      for (const t of detectLevelTouches(paperOpen)) {
        const pushed = await _pushIfFresh(_touchAlerts, `${t.id}:${t.kind}`, formatLevelTouch(t), TOUCH_COOLDOWN_MS, send);
        if (pushed) {
          _status.paperPushes++;
          _status.lastPushAt = Date.now();
          console.log(`[insta-push] paper ${t.kind} touch ${t.pair} @ ${t.ltp} (India desk)`);
        }
      }
      if (paperOpen.length > 0) nextDelay = TICK_ACTIVE_MS; // paper desk open → stay at the 5s cadence
    } catch { /* paper desk optional — never break the crypto path */ }

    // --- 1c) v10.16 S2: MANUAL trades — the user's OWN positions ride
    //     the same 5s level-touch pipeline (SL/T1/T2, MANUAL tagged).
    //     The LTP used is the manual monitor's sweep stamp (__ltp) — no
    //     new fetch path, no new cadence. Store failures contained.
    try {
      const manualOpen = manualTradesToPositionRows(listManualTrades({ status: 'OPEN' }));
      for (const t of detectLevelTouches(manualOpen)) {
        const pushed = await _pushIfFresh(_touchAlerts, `${t.id}:${t.kind}`, formatLevelTouch(t), TOUCH_COOLDOWN_MS, send);
        if (pushed) {
          _status.manualPushes++;
          _status.lastPushAt = Date.now();
          console.log(`[insta-push] manual ${t.kind} touch ${t.pair} @ ${t.ltp}`);
        }
      }
      if (manualOpen.length > 0) nextDelay = TICK_ACTIVE_MS; // manual trades open → 5s cadence
    } catch { /* manual desk optional — never break other paths */ }

    // --- 2) fresh STRONG signals (every ~30s; board cache + single-
    //     flight keeps the underlying compute at its own cadence) ---
    _tickN++;
    if (_tickN % SIGNAL_SCAN_EVERY_N_TICKS === 0 && _deps?.getSignals) {
      const cfg = loadConfig();
      if (!cfg.killSwitch) { // parity with the legacy alerter
        // v20.2: FUTURES (B-USDT perps) added — the 3rd live desk was
        // missing from STRONG pushes entirely (only CRYPTO + INDIA
        // scanned). GLOBALFUTURES stays out: it's the USDC equity SIM
        // desk — simulated pushes would pollute the real alert stream.
        for (const mkt of ['CRYPTO', 'INDIA', 'FUTURES']) {
          const pushed = await _scanAndPushStrongs(mkt, _deps, send);
          if (pushed) {
            _status.signalPushes += pushed;
            _status.lastPushAt = Date.now();
          }
        }
      }
    }
    _status.lastOkAt = Date.now();
    _status.lastError = null;
  } catch (e) {
    _status.lastError = String(e?.message || e).slice(0, 160);
  } finally {
    _ticking = false;
    if (_timer) {
      _timer = setTimeout(_tick, nextDelay);
      if (typeof _timer.unref === 'function') _timer.unref();
    }
  }
}

/**
 * Boot the sink (idempotent). Called from ai/routes.js registration with
 * the SAME getSignals + deps the boards use — no second pipeline.
 * v20.2: `fastWatchSpot` (injected → no import cycle) is the 5s front-line
 * executor: when the sink sees a level touch on a live SPOT position it
 * calls the position watcher NOW instead of waiting out the 60s loop.
 */
export function startInstaPushSink({ getSignals, depsForSignals, fastWatchSpot, tgEnv } = {}) {
  if (_deps == null && getSignals) _deps = { getSignals, depsForSignals };
  if (typeof fastWatchSpot === 'function') _fastWatchSpot = fastWatchSpot;
  if (tgEnv && (tgEnv.token || tgEnv.chatId)) _tgEnv = { token: tgEnv.token || '', chatId: tgEnv.chatId || '' };
  if (_timer) return; // already running
  if (!instantPushEnabled()) { _status.enabled = false; return; }
  _status.started = true;
  _status.startedAt = Date.now();
  _timer = setTimeout(_tick, 3_000);
  if (typeof _timer.unref === 'function') _timer.unref();
  console.log('[insta-push] Telegram instant-push sink armed (5s levels · 30s STRONG scan · watchers stay executors)');
}

/** The backup alerter's scan — SAME dedupe map so nothing double-sends.
 *  routes.js's 60s loop calls this; whichever path sees the signal first
 *  wins, the other no-ops. */
export async function scanStrongSignalsBackup({ getSignals, depsForSignals, markets = ['CRYPTO', 'INDIA', 'FUTURES'], tgEnv } = {}) {
  if (tgEnv && (tgEnv.token || tgEnv.chatId)) _tgEnv = { token: tgEnv.token || '', chatId: tgEnv.chatId || '' };
  const cfgTG = telegramConfig(_tgEnv || {});
  if (!cfgTG) return { ok: false, pushed: 0 };
  const send = (text) => sendTelegramMessage(text, { token: cfgTG.token, chatId: cfgTG.chatId });
  let pushed = 0;
  const cfg = loadConfig();
  if (cfg.killSwitch) return { ok: true, pushed };
  for (const mkt of markets) {
    const n = await _scanAndPushStrongs(mkt, { getSignals, depsForSignals }, send);
    if (n) {
      pushed += n;
      _status.signalPushes += n;
      _status.lastPushAt = Date.now();
    }
  }
  return { ok: true, pushed };
}

/** Pipeline health — the legacy bot's backup cron consults this. */
export function instaPushStatus() {
  return {
    ok: true,
    enabled: _status.enabled && instantPushEnabled(),
    started: _status.started,
    startedAt: _status.startedAt,
    lastOkAt: _status.lastOkAt,
    lastPushAt: _status.lastPushAt,
    slTpPushes: _status.slTpPushes,
    paperPushes: _status.paperPushes,
    manualPushes: _status.manualPushes,
    signalPushes: _status.signalPushes,
    lastError: _status.lastError,
    // v21.0 TELEGRAM DELIVERY HEALTH (telegram fix T4): 24h rolling
    // sent/failed counters — UI panel me "kyun nahi aa rahe" ka jawab.
    delivery: telegramDeliveryHealth(),
    // healthy = a poll succeeded within the last 3 minutes. The legacy
    // bot's 10-min cron uses this to decide backup vs silence.
    healthy: !!(_status.lastOkAt && Date.now() - _status.lastOkAt < 3 * 60 * 1000 && instantPushEnabled()),
    note: 'Instant push = early warning (level touch, CoinDCX + India paper desks). Watcher = executor + fill truth. Legacy cron = backup heartbeat only. Delivery = 24h sent/failed counters (v21.0).',
  };
}

// ---------------- test hooks ----------------
export async function __tickForTests() { await _tick(); }
export function __statusForTests() { return _status; }
export function __mapsForTests() { return { _touchAlerts, _strongAlerts }; }
export function __depsForTests() { return _deps; }
export function __setDepsForTests(d) { _deps = d; }
export function __setFastWatchForTests(fn) { _fastWatchSpot = fn; _fastWatchLastAt = 0; }
export function __resetInstaPushForTests() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _ticking = false;
  _tickN = 0;
  _touchAlerts.clear();
  _strongAlerts.clear();
  _fastWatchSpot = null;
  _fastWatchLastAt = 0;
  Object.assign(_status, {
    started: false, enabled: true, startedAt: null, lastOkAt: null,
    lastPushAt: null, slTpPushes: 0, paperPushes: 0, manualPushes: 0, signalPushes: 0, lastError: null,
  });
}
