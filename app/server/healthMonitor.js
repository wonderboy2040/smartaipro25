// ============================================================
// server/healthMonitor.js — v21.1.0 (Phase-3)
// ------------------------------------------------------------
// EK jagah se poore terminal ka operational health:
//   • FEEDS: har source ka last-tick age seconds me (liveFeed.feedAges
//     + CoinDCX futures WS + Binance futures WS + CoinDCX spot WS)
//   • KILLS: teeno layers — AI-desk config killSwitch, exec
//     reconciler L1/L2/L3, Bot Lab per-bot/global STOP files
//   • BOTS: Bot Lab status snapshot (mode, globalPause, heartbeats)
//   • PERSIST: exec heartbeat age + server/data writability probe
//   • ALERTING: 60s loop — koi bhi armed feed >90s stale ho, ya
//     kill arm ho, ya heartbeat >30s stale ho → Telegram push
//     (15-min per-key throttle, dedup).
//
// Design notes:
//   * /health (existing, deep liveness) aur /api/ping (zero-work
//     supervisor probe) ko TOUCH nahi kiya — ye unka ADDITION hai.
//   * Sab imports LAZY/dynamic hain: module load order + test
//     isolation safe (index.js boot pe initHealthMonitor() chalega).
//   * Fail-open READS: koi bhi sub-system unreachable ho to uska
//     status "unknown" aata hai — poora endpoint kabhi nahi girta.
// ============================================================

// v21.1.0 (Phase-3): import.meta.url-based app root — process.cwd() launch
// dir pe depend nahi karta (npm start / supervisor / tests sab se same).
// NOTE: __dirname ESM me defined NAHI hai (vitest shim chhupata hai, real
// node me ReferenceError aata tha) — fileURLToPath hi theek tareeka hai.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const _APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const _alertLastAt = {};   // alertKey -> epoch (15-min throttle)
const _state = { timer: null, inited: false };

const ALERT_THROTTLE_MS = 15 * 60_000;
export const FEED_STALE_ALERT_SEC = 90;   // armed feed itna stale → alert
export const HEARTBEAT_STALE_SEC = 30;   // exec heartbeat stale window
// v21.1.1 [audit A13]: data-dir probe 60s cache (request-path sync FS off)
const _probeCache = { at: 0, dataDirs: null };

async function _sendTelegram(text) {
  try {
    const { sendTelegramMessage, telegramConfig } = await import('./ai/secrets.js');
    const tg = typeof telegramConfig === 'function' ? (telegramConfig() || {}) : {};
    const r = await sendTelegramMessage(text, { token: tg.token || process.env.TG_TOKEN || '', chatId: tg.chatId || process.env.TG_CHAT_ID || '' });
    return r?.ok === true;
  } catch { return false; }
}

function _throttledAlert(key, text) {
  const now = Date.now();
  if (now - (_alertLastAt[key] || 0) < ALERT_THROTTLE_MS) return false;
  _alertLastAt[key] = now;
  _sendTelegram(text).catch(() => { /* alert send best-effort */ });
  return true;
}

/** Aggregated snapshot — /api/health response body builder. */
export async function healthSnapshot() {
  const now = Date.now();
  const out = {
    ok: true,
    at: now,
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    memoryMB: Math.round((process.memoryUsage?.()?.rss || 0) / 1048576),
    feeds: { sources: {}, ws: {} },
    kills: {},
    bots: null,
    persist: {},
  };

  // ---- FEEDS: liveFeed source ages ----
  try {
    const { feedAges, feedStatus } = await import('./liveFeed.js');
    const ages = feedAges();
    const booleans = feedStatus();
    // v21.1.1 [audit A3]: India sources (groww-live/yahoo-delayed) sirf NSE
    // hours me tick karte hain — market band hone ke baad unka "stale" hona
    // NORMAL hai, down nahi. Raat/weekend pe false feeds_stale alerts + red
    // FEEDS chip the. Ab India sources market-closed pe stale-count me nahi
    // aate (crypto feeds 24/7 hain, wo pehle jaise).
    let nseOpen = null;
    try {
      const { isNseMarketOpen } = await import('./intraday/time.js');
      nseOpen = isNseMarketOpen();
    } catch { nseOpen = null; /* time.js unavailable — unfiltered (safe) */ }
    const INDIA_FEED_SOURCES = new Set(['groww-live', 'yahoo-delayed', 'groww', 'yahoo', 'groww-api']);
    const staleArmed = [];
    for (const [src, a] of Object.entries(ages)) {
      out.feeds.sources[src] = { ...a, live: booleans[src] === true };
      if (INDIA_FEED_SOURCES.has(String(src).toLowerCase()) && nseOpen === false) continue;
      if (a.ageSec > FEED_STALE_ALERT_SEC) staleArmed.push(src);
    }
    out.feeds.staleSources = staleArmed;
  } catch { out.feeds.sources = { error: 'liveFeed unavailable' }; }

  // ---- FEEDS: dedicated WS health (futures/spot/binance) ----
  // v21.1.1 [audit A2]: IDLE-AWARE armed tracking. Ye streams refcounted hain
  // — koi SSE/browser client nahi to _stopIfIdle() socket band kar deta hai
  // (healthy:false, ageSec:null = IDLE, DOWN nahi). Headless deploys pe iska
  // matlab tha: har 15 min "WebSocket down" false alert. Ab armed = active
  // subscribers (futures/glob domains) ya tier wantOpen.
  let _cxArmed = false;
  try {
    const { cxRtWsStatus } = await import('./ai/cxRtStream.js');
    const cx = cxRtWsStatus();
    _cxArmed = cx?.enabled === true && ((cx?.domains?.fut || 0) + (cx?.domains?.glob || 0)) > 0;
    out.feeds.ws.coindcxFutures = {
      healthy: cx?.healthy === true,
      lastTickAt: cx?.lastTickAt ?? null,
      ageSec: cx?.lastTickAt ? Math.max(0, Math.round((now - cx.lastTickAt) / 1000)) : null,
      armed: _cxArmed, // idle-by-design (no subscribers) = alerting nahi hogi
      // v21.1.2 (report-1.5): "kyun down" seedha health me — cooldown phase
      // me REST 2s polling chalta rehta hai (prices aate hain), WS sirf
      // accelerator band hota hai. UI tooltip + automated monitors ab
      // reason/streak/remaining dekh sakte hain bina /api/feed-status ke.
      cooldownReason: cx?.cooldownReason ?? null, // 'handshake-streak' | 'silent-contract' | 'glob-quiet' | null
      failStreak: Number.isFinite(cx?.failStreak) ? cx.failStreak : 0,
      cooldownRemainMs: cx?.cooldownActive === true ? Math.max(0, cx?.cooldownRemainMs || 0) : 0,
    };
    if (cx?.spotWs) {
      out.feeds.ws.coindcxSpot = {
        healthy: cx.spotWs.healthy === true,
        lastUpdateAt: cx.spotWs.lastUpdateAt ?? null,
        ageMs: cx.spotWs.ageMs ?? null,
        armed: _cxArmed,
        failStreak: Number.isFinite(cx?.failStreak) ? cx.failStreak : 0,
        cooldownRemainMs: cx?.cooldownActive === true ? Math.max(0, cx?.cooldownRemainMs || 0) : 0,
      };
    }
  } catch { /* cxRtStream not armed */ }
  try {
    const { binanceFutStatus } = await import('./ai/binanceFutWs.js');
    const b = binanceFutStatus();
    out.feeds.ws.binanceFutures = {
      healthy: b?.healthy === true,
      lastTickAt: b?.lastTickAt ?? null,
      ageSec: b?.lastTickAt ? Math.max(0, Math.round((now - b.lastTickAt) / 1000)) : null,
      armed: b?.enabled === true && b?.wantOpen === true,
      // v21.1.2 (report-1.5): parity with coindcxFutures entry (binance tier
      // me explicit reason string nahi hai — sirf streak + remain).
      failStreak: Number.isFinite(b?.failStreak) ? b.failStreak : 0,
      cooldownRemainMs: b?.cooldownActive === true ? Math.max(0, b?.cooldownRemainMs || 0) : 0,
    };
  } catch { /* binanceFutWs not armed */ }

  // ---- FEEDS: v21.6 official Groww Trading-API tier (India 1s LTP) ----
  // armed=false (no GROWW_API_KEY/SECRET) is NORMAL — the public 1.5s tier
  // carries India then; breakerActive=true means the API tier is holding
  // off after repeated failures (public tier unaffected).
  try {
    const { growwApiStatus } = await import('./ai/growwApi.js');
    out.feeds.growwApi = growwApiStatus();
  } catch { /* growwApi unavailable */ }

  // ---- KILLS: 3 layers ----
  try {
    const { loadConfig } = await import('./ai/coindcxOrders.js');
    out.kills.aiDesk = { enabled: loadConfig()?.killSwitch === true };
  } catch { out.kills.aiDesk = { error: 'unavailable' }; }
  try {
    const { killLevel, killReason, isKilled } = await import('./exec/reconciler.js');
    out.kills.exec = { level: killLevel(), reason: killReason(), isKilled: isKilled() };
  } catch { out.kills.exec = { error: 'unavailable' }; }
  try {
    const { activeKillSwitches, globalPauseActive } = await import('./bots/botState.js');
    out.kills.botLab = { bots: activeKillSwitches(), globalPause: globalPauseActive() };
  } catch { out.kills.botLab = { error: 'unavailable' }; }

  // ---- BOTS: Bot Lab snapshot (PEEK ONLY — runner create kabhi nahi karta;
  // getBotRunner() singleton null-provider wiring se corrupt ho sakta tha) ----
  try {
    const mod = await import('./bots/routes.js');
    const runner = typeof mod.peekBotRunner === 'function' ? mod.peekBotRunner() : null;
    if (runner && typeof runner.status === 'function') {
      const st = runner.status();
      out.bots = {
        mode: st?.mode ?? null,
        globalPause: st?.globalPause === true,
        scheduler: st?.scheduler ?? null,
        bots: (st?.bots || []).map(b => ({
          bot: b.bot, mode: b.mode, arm: b.arm,
          killSwitch: b.killSwitch === true,
          heartbeatAgeSec: b.heartbeat?.at ? Math.max(0, Math.round((now - b.heartbeat.at) / 1000)) : null,
        })),
      };
    }
  } catch { /* bot lab not armed */ }

  // ---- AI PROVIDERS ----
  // feeds.ai.jev: reachable/breaker/p95 — OpsHealthStrip AI chip isi
  // se render hota hai. PEEK-ONLY (runner nahi banata — upar wale BOTS
  // section jaisa hi discipline). v21.14: laya removed.
  try {
    const mod = await import('./bots/routes.js');
    const runner = typeof mod.peekBotRunner === 'function' ? mod.peekBotRunner() : null;
    if (runner && runner.ai) {
      const { providerHealth } = await import('./bots/aiProviders.js');
      const ph = providerHealth(runner.ai);
      out.ai = { jev: ph.jev };
    }
  } catch { /* AI providers not armed */ }

  // ---- v21.3.0 (Issue-5): board AI-confirmation layer status ----
  // ai.boardConfirm: mode/providers configured + n + the provider health —
  // "board signals AI-verified hain ya nahi" ek health call me visible.
  try {
    const { boardAiConfirmStatus } = await import('./ai/boardAiConfirm.js');
    out.ai = out.ai || {};
    out.ai.boardConfirm = boardAiConfirmStatus();
  } catch { /* board confirm layer not armed */ }

  // ---- v21.3.0 (Issue-1): selfHeal platform profile ----
  // platformConstrained: Render/Railway/small-container detection ON hai —
  // memory limits + exit-on-fatal ka auto-profile laga tha ya nahi.
  try {
    const { selfHealthSnapshot } = await import('./ai/selfHeal.js');
    const sh = selfHealthSnapshot();
    out.selfHeal = {
      armed: sh.armed,
      exitOnFatal: sh.exitOnFatal,
      platformConstrained: sh.platformConstrained === true,
      limitsMB: sh.memory?.limitsMB || null,
      counts: sh.counts || null,
      loopLagMs: sh.loopLagMs || null,
    };
  } catch { /* selfHeal peek best-effort */ }

  // ---- PERSIST: exec heartbeat (file-based dead-man switch) + data-dir writability ----
  try {
    const fs = await import('node:fs');
    const hbFile = path.join(_APP_ROOT, 'data', 'execution-heartbeat.json');
    let hbAt = null;
    try {
      const hb = JSON.parse(fs.readFileSync(hbFile, 'utf8'));
      hbAt = Number(hb?.at) || null;
      // v21.1.1 [audit A9]: 24h+ purani heartbeat = PREVIOUS run ki chhodi
      // hui file (current boot me reconciler armed nahi hai). Alert nahi —
      // warna har plain `npm start` boot pe permanent false "reconcile stuck".
      if (hbAt && now - hbAt > 24 * 3600_000) hbAt = null;
    } catch { /* file nahi hai = reconciler not armed — ageSec null (honest) */ }
    out.persist.execHeartbeat = { at: hbAt, ageSec: hbAt ? Math.max(0, Math.round((now - hbAt) / 1000)) : null };
  } catch { /* heartbeat read best-effort */ }
  try {
    const fs = await import('node:fs');
    // v21.1.1 [audit A13]: probe result 60s cache — pehle HAR /api/health
    // request (2 strips × 30s poll) + 60s loop pe 2 dirs × (mkdir+write+
    // unlink) sync FS chalte the. Ab max ek probe/min.
    if (_probeCache.at && now - _probeCache.at < 60_000) {
      out.persist.dataDirs = { ..._probeCache.dataDirs };
    } else {
      // Dono persist dirs: lib/store.js ka DATA_DIR (env-respecting —
      // SMARTAI_DATA_DIR override bhi cover) aur app/data (bot lab + exec
      // heartbeat — reconciler). ReadOnly mount ya disk-full pe pehla write
      // hi fail hota hai.
      const dataDirs = {};
      let storeDir = path.join(_APP_ROOT, 'server', 'data');
      try {
        const { DATA_DIR } = await import('./lib/store.js');
        if (DATA_DIR) storeDir = DATA_DIR;
      } catch { /* default path */ }
      for (const dir of [storeDir, path.join(_APP_ROOT, 'data')]) {
        const label = path.basename(path.dirname(dir)) === 'app' ? 'app/data' : `server-data(${path.basename(dir)})`;
        const probe = path.join(dir, `.health-probe-${process.pid}`);
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(probe, String(now));
          fs.unlinkSync(probe);
          dataDirs[label] = true;
        } catch { dataDirs[label] = false; }
      }
      _probeCache.at = now;
      _probeCache.dataDirs = dataDirs;
      out.persist.dataDirs = { ...dataDirs };
    }
    out.persist.dataDirWritable = Object.values(out.persist.dataDirs).every(Boolean) === true;
  } catch { out.persist.dataDirWritable = false; out.persist.dataDirs = { error: 'probe failed' }; }

  // ---- overall ok ----
  // v21.1.1 [audit A10]: ok ab kills KE SAATH persist-failures + Bot Lab
  // global pause bhi dekhta hai — read-only disk pe bhi automated monitors
  // ko red milna chahiye (pehle sirf kills dikhte the).
  const killActive = out.kills?.aiDesk?.enabled === true || (out.kills?.exec?.level || 0) > 0 || out.kills?.botLab?.globalPause === true;
  const persistBad = out.persist?.dataDirWritable === false;
  out.ok = !killActive && !persistBad;
  return out;
}

/** 60s alert loop — feeds stale / kills armed / heartbeat stale → Telegram. */
async function _healthAlertTick() {
  const snap = await healthSnapshot();

  // (1) stale armed feeds
  const stale = snap.feeds?.staleSources || [];
  if (stale.length > 0) {
    _throttledAlert('feeds_stale', `🩺 HEALTH: ${stale.length} feed source(s) STALE >${FEED_STALE_ALERT_SEC}s — ${stale.slice(0, 6).join(', ')}${stale.length > 6 ? ' …' : ''}. UI prices in sources ke liye trusted nahi — /api/feed-status check karo.`);
  }

  // (2) WS health (futures perp feed is the live-trading critical one)
  // v21.1.1 [audit A2]: sirf ARMED streams alert hote hain (active
  // subscribers / wantOpen). Idle-by-design (koi client nahi) = normal.
  const wsStale = [];
  for (const [k, v] of Object.entries(snap.feeds?.ws || {})) {
    if (v?.armed === false) continue; // idle-by-design — not down
    if (v?.healthy === false && (v.ageSec == null || v.ageSec > FEED_STALE_ALERT_SEC)) wsStale.push(k);
  }
  if (wsStale.length > 0) {
    _throttledAlert('ws_stale', `🩺 HEALTH: WebSocket down — ${wsStale.join(', ')}. Futures desk live-tick gap me honest degrade hoga.`);
  }

  // (3) kill switches armed
  if (snap.kills?.aiDesk?.enabled === true) _throttledAlert('kill_ai', '🩺 HEALTH: AI-desk KILL SWITCH ON hai — koi bhi auto/live entry fire nahi hogi.');
  const lvl = snap.kills?.exec?.level || 0;
  if (lvl > 0) _throttledAlert('kill_exec', `🩺 HEALTH: EXEC KILL L${lvl} ACTIVE (${snap.kills?.exec?.reason || 'no reason'}) — live entries blocked${lvl >= 2 ? ', flatten/reduce mode' : ''}.`);
  if (snap.kills?.botLab?.globalPause === true) _throttledAlert('kill_bots_global', '🩺 HEALTH: Bot Lab GLOBAL PAUSE (STOP_ALL) active hai.');

  // (4) exec heartbeat stale (dead-man switch)
  const hbAge = snap.persist?.execHeartbeat?.ageSec;
  if (hbAge != null && hbAge > HEARTBEAT_STALE_SEC) {
    _throttledAlert('hb_stale', `🩺 HEALTH: exec heartbeat ${hbAge}s STALE (> ${HEARTBEAT_STALE_SEC}s) — reconcile loop atka hua lag raha hai. /api/exec/status check karo.`);
  }

  // (5) data dir read-only (Render disk full / ephemeral mount gone)
  if (snap.persist?.dataDirWritable === false) {
    const bad = Object.entries(snap.persist?.dataDirs || {}).filter(([, ok]) => ok === false).map(([d]) => d).join(', ') || 'data dirs';
    _throttledAlert('disk_ro', `🩺 HEALTH: data-dir write FAIL (${bad}) — journal/ledger/bot-state persist nahi ho rahe! Render disk full ya read-only mount check karo.`);
  }

  // (6) AI provider down for a SELECTED arm
  // Sirf wahi providers alert hote hain jinka koi bot ka current arm use
  // karta hai (jev/auto). Not-configured provider (null instance)
  // breaker-open ho hi nahi sakta — config fallback event pehle hi
  // arm_fallback me record ho chuka hai. v21.14: laya removed.
  if (snap.ai) {
    const armsInUse = new Set((snap.bots?.bots || []).map((b) => String(b?.arm || '')).filter(Boolean));
    const jevUsed = armsInUse.has('jev') || armsInUse.has('auto');
    if (jevUsed && snap.ai.jev?.breakerOpen === true) {
      _throttledAlert('ai_jev_down', `🩺 HEALTH: Bot Lab AI provider JEV DOWN (breaker open) — jev/auto arm wale bots WAIT mode me hain. TYPESAFE_API_KEY / endpoint check karo.`);
    }
  }
}

export function initHealthMonitor() {
  if (_state.inited) return true;
  _state.inited = true;
  try {
    _state.timer = setInterval(() => { _healthAlertTick().catch(() => { /* never fatal */ }); }, 60_000);
    if (typeof _state.timer.unref === 'function') _state.timer.unref();
  } catch { /* timer best-effort */ }
  return true;
}

/** Tests ke liye — throttle map reset. */
export function _resetForTests() {
  for (const k of Object.keys(_alertLastAt)) delete _alertLastAt[k];
  _probeCache.at = 0; _probeCache.dataDirs = null; // v21.1.1 [audit A13]
}
