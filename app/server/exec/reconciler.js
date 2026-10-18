// ============================================================
// server/exec/reconciler.js — v20.7 RECONCILE + DEAD-MAN + KILL-SWITCH
// ------------------------------------------------------------
// Phase 5 of the auto-trading plan (app/docs/audit.md §4). The last-
// line safety layer:
//
//   • RECONCILE LOOP (10–15s): port.getPositions() = truth.
//       - Exchange par position hai par journal me nahi (orphan) →
//         adopt + protection check (if no SL → flatten + alert).
//       - Journal me hai par exchange par nahi (ghost) → close with
//         honest reason (native SL/TP/liq/manual).
//       - Qty mismatch → exchange ka sync.
//
//   • DEAD-MAN SWITCH: positionManager har 5s heartbeat likhe
//     (server/data/execution-heartbeat.json). Alag watchdog agar
//     heartbeat > 30s stale AND open positions exist → Telegram
//     CRITICAL. Native SL exchange par pehle se hai, so the dead-man
//     is INFORMATIONAL (not aflatten trigger).
//
//   • KILL-SWITCH HIERARCHY:
//       L1 — no new entries (positions managed normally)
//       L2 — reduce-only (close all open positions, no new)
//       L3 — flatten + disable engine (close all + refuse future starts)
//     Triggers: UI button, Telegram /halt, file flag, auto (daily loss,
//     RAM RED, API errors, clock skew, Chrome/CDP lost).
//
//   • LEADER LEASE: execution sirf ek node (SMARTAI_EXEC_NODE=laptop).
//     Render copy par PROTRADER_AUTO force-off + lease check (durable
//     store). Prevents duplicate orders when both nodes are up.
//
//   • STARTUP RECOVERY: restart par pehle port.getPositions() →
//     protection verify → phir hi koi naya entry.
//
// The reconciler NEVER throws. Every action is logged to the journal.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_FILE_DEFAULT = path.join(__dirname, '..', '..', 'data', 'execution-heartbeat.json');
const KILL_FLAG_FILE_DEFAULT = path.join(__dirname, '..', '..', 'data', 'execution-kill.flag');

const _state = {
  armed: false,
  killLevel: 0, // 0 = none, 1 = L1 no-new, 2 = L2 reduce-only, 3 = L3 flatten+disable
  killReason: null,
  killSetAt: 0,
  heartbeatAt: 0,
  heartbeatFile: HEARTBEAT_FILE_DEFAULT,
  killFlagFile: KILL_FLAG_FILE_DEFAULT,
  port: null,
  positionManager: null,
  alertSink: null,
  _timer: null,
  _leaderNode: 'laptop',
  // v20.9.4 FIX (H3 follow-up — cold-state leader default): module-cold
  // default FALSE tha jabki documented semantics "unset SMARTAI_EXEC_NODE
  // → treated as the leader (single-node setups keep working)" hai. v20.9.4
  // ka naya agent-loop/SAPTA leader-lease gate isLeader() DYNAMIC import
  // se padhta hai — reconciler un-initialized (unit tests, standalone
  // imports) ho to false cold-default HAR entry ko "non_leader" skip pe
  // bhej deta tha (31 tests red). initReconciler() ab bhi env se
  // re-evaluate karta hai (mismatch → false); canEnterNew() ko 'armed'
  // bhi chahiye isliye exec/enter route production me unaffected.
  _iAmLeader: true,
  // v21.1.1 [audit B1]: flag-file se restore hua kill isi ko auto-resume karta hai
  _killFromFlagFile: false,
  // v20.7.12 [H1]: advisory-alert dedupe (pair → last alert ts, 30 min)
  _adoptAlerts: new Map(),
  // v20.7.12 [H1]: engine-ownership cache (journal scan is not free —
  // 60s TTL; the reconcile loop runs every 12s)
  _enginePairs: null,
  _enginePairsAt: 0,
};

/** v20.7.12 [H1] — CRITICAL SAFETY FIX. The old orphan sweep flattened
 * ANY exchange position absent from PositionManager state whenever it had
 * no SL — par production me PM state KABHI populate nahi hoti thi
 * (protectionFirstEntry/tick ke zero call-sites the), isliye EXEC_MODE=api
 * pe user ke apne MANUAL positions bhi 12s me market-close ho jate the.
 * Ab flatten SIRF engine-owned positions pe (journal me recent LIVE
 * FUTURES ORDER/OPEN row); manual positions ke liye ADOPT-ONLY + throttled
 * advisory alert — reconciler kabhi bhi user ka paisa nahi chhoota. */
const ENGINE_OWN_TTL_MS = 24 * 3600_000;
const ADOPT_ALERT_EVERY_MS = 30 * 60_000;
const ENGINE_SCAN_TTL_MS = 60_000;

async function _engineOwnedLivePairs() {
  if (_state._enginePairs && Date.now() - _state._enginePairsAt < ENGINE_SCAN_TTL_MS) {
    return _state._enginePairs;
  }
  const pairs = new Set();
  try {
    const { loadJournal } = await import('../ai/coindcxOrders.js');
    const j = loadJournal();
    const cutoff = Date.now() - ENGINE_OWN_TTL_MS;
    for (const p of (Array.isArray(j?.positions) ? j.positions : [])) {
      if (p?.status === 'OPEN' && String(p?.mode) === 'live'
        && (String(p?.market) === 'FUTURES' || String(p?.market) === 'GLOBALFUTURES')
        && p?.pair && (Number(p?.openedAt) || 0) >= cutoff) pairs.add(String(p.pair));
    }
    for (const e of (Array.isArray(j?.entries) ? j.entries : [])) {
      // v21.1.1 [audit B8]: desks ORDER entries me `symbol` likhte hain
      // (`pair` sirf exec-enter route) — purana `e?.pair` check is fallback
      // ka intezaam hi kabhi match nahi karta tha (crash-window orphan
      // safety net dead code). `pair ?? symbol` + REJECTED filter (ek
      // reject hui order user ki manual same-pair position ko flatten
      // trigger nahi karni chahiye).
      if (e?.kind === 'ORDER' && String(e?.mode) === 'live' && String(e?.market) === 'FUTURES'
        && !['REJECTED', 'FAILED'].includes(String(e?.status || ''))
        && (e?.pair || e?.symbol) && (Number(e?.ts) || 0) >= cutoff) pairs.add(String(e.pair || e.symbol));
    }
  } catch { /* journal unavailable → empty set (fail-SAFE: no flatten) */ }
  _state._enginePairs = pairs;
  _state._enginePairsAt = Date.now();
  return pairs;
}

function _adoptAlertThrottled(p) {
  const key = String(p.pair || '');
  const last = _state._adoptAlerts.get(key) || 0;
  if (Date.now() - last < ADOPT_ALERT_EVERY_MS) return;
  _state._adoptAlerts.set(key, Date.now());
  if (_state._adoptAlerts.size > 100) { // bounded
    const first = _state._adoptAlerts.keys().next().value;
    if (first !== undefined) _state._adoptAlerts.delete(first);
  }
  _alertCall(`ℹ️ MANUAL position ${p.pair} (no exchange SL) adopt-only — engine iska close NAHI karegi. Broker app me SL lagao ya position manage karo.`);
}

export function initReconciler({ port, positionManager = null, alertSink = null, env = process.env, heartbeatFile, killFlagFile } = {}) {
  _state.armed = true;
  _state.port = port;
  _state.positionManager = positionManager;
  _state.alertSink = typeof alertSink === 'function' ? alertSink : null;
  _state.heartbeatFile = heartbeatFile || HEARTBEAT_FILE_DEFAULT;
  _state.killFlagFile = killFlagFile || KILL_FLAG_FILE_DEFAULT;
  // Leader lease: SMARTAI_EXEC_LEADER = the ONE node allowed to place orders
  // (default 'laptop'); SMARTAI_EXEC_NODE = the name of THIS node. Unset NODE
  // → treated as the leader (single-node setups keep working). A mismatch
  // (e.g. a Render copy with SMARTAI_EXEC_NODE=render) → never enters new
  // trades, preventing duplicate orders when both nodes are up.
  _state._leaderNode = String(env.SMARTAI_EXEC_LEADER || 'laptop');
  _state._iAmLeader = !env.SMARTAI_EXEC_NODE || String(env.SMARTAI_EXEC_NODE) === _state._leaderNode;
  // initial kill-flag file check
  _checkKillFlagFile();
  // initial heartbeat
  _writeHeartbeat();
  // 12s reconcile cadence, unref'd so the timer never keeps the loop alive
  try {
    if (_state._timer) clearInterval(_state._timer);
    _state._timer = setInterval(_reconcileTick, 12_000);
    if (typeof _state._timer.unref === 'function') _state._timer.unref();
  } catch { /* timer best-effort */ }
  return true;
}

export function killLevel() { return _state.killLevel; }
export function killReason() { return _state.killReason; }
export function isKilled() { return _state.killLevel > 0; }
export function canEnterNew() { return _state.armed && _state.killLevel === 0 && _state._iAmLeader; }
export function isLeader() { return _state._iAmLeader; }
export function leaderNode() { return _state._leaderNode; }

export function setKill(level, reason) {
  const lvl = Math.max(0, Math.min(3, Number(level) || 0));
  if (lvl > _state.killLevel) {
    _state.killLevel = lvl;
    _state.killReason = String(reason || 'manual');
    _state.killSetAt = Date.now();
    _persistKillFlag();
    _alertCall(`🚨 KILL L${lvl}: ${reason}. ${lvl === 1 ? 'No new entries.' : lvl === 2 ? 'Reduce-only — closing all open positions.' : 'Flatten + disable engine.'}`);
  } else if (lvl === 0) {
    _state.killLevel = 0;
    _state.killReason = null;
    _state.killSetAt = 0;
    _clearKillFlag();
    _alertCall(`✅ KILL CLEARED — engine active again.`);
  }
  return { level: _state.killLevel, reason: _state.killReason };
}

async function _reconcileTick() {
  try {
    if (!_state.armed || !_state.port) return;
    // re-check kill-flag file (UI / Telegram / external supervisor can write it)
    _checkKillFlagFile();
    // heartbeat (the dead-man switch reads this; if missing for 30s +
    // open positions → Telegram CRITICAL)
    _writeHeartbeat();

    // L3: flatten all + return
    // v21.1.0 (Phase-2 audit fix #7): failed closes pehle SILENT the — L3
    // kill ke dauran flatten fail hone par position open reh jaati thi, koi
    // retry nahi, koi alert nahi. Ab ek immediate retry + phir bhi fail to
    // CRITICAL alert (12s agla tick dobara try karega).
    if (_state.killLevel >= 3) {
      const positions = await _state.port.getPositions();
      for (const p of positions) {
        let closed = false, lastErr = null;
        for (let attempt = 0; attempt < 2 && !closed; attempt++) {
          try { await _state.port.close({ positionId: p.id }); closed = true; }
          catch (e) { lastErr = e; }
        }
        if (!closed) _alertCall(`🚨 L3 FLATTEN FAILED ${p.pair}: ${String(lastErr?.message || lastErr || '').slice(0, 120)} — next 12s tick retry karega, MANUAL VERIFY KARO.`);
      }
      return;
    }

    // L2: reduce-only (close all open, but new entries blocked)
    if (_state.killLevel === 2) {
      const positions = await _state.port.getPositions();
      for (const p of positions) {
        let closed = false, lastErr = null;
        for (let attempt = 0; attempt < 2 && !closed; attempt++) {
          try { await _state.port.close({ positionId: p.id }); closed = true; }
          catch (e) { lastErr = e; }
        }
        if (!closed) _alertCall(`🚨 L2 REDUCE-ONLY CLOSE FAILED ${p.pair}: ${String(lastErr?.message || lastErr || '').slice(0, 120)} — next 12s tick retry karega, MANUAL VERIFY KARO.`);
      }
      return;
    }

    // RECONCILE: getPositions() = truth
    const positions = await _state.port.getPositions();
    const knownIds = new Set(positions.map(p => p.id));
    // orphans (exchange has, positionManager doesn't) → v20.7.12 [H1]:
    // flatten SIRF engine-owned (recent LIVE journal row) orphans pe —
    // manual positions adopt-only hain (advisory alert, kabhi close nahi).
    if (_state.positionManager) {
      const pmState = _state.positionManager._stateForTests ? _state.positionManager._stateForTests() : [];
      const pmIds = new Set(pmState.map(s => s.id));
      const enginePairs = await _engineOwnedLivePairs();
      for (const p of positions) {
        if (pmIds.has(p.id)) continue;
        const noSl = p.sl == null || Number(p.sl) <= 0;
        // v20.7.3: numeric trigger fields often use 0 as the "unset"
        // sentinel — treat sl<=0 as unprotected too.
        if (enginePairs.has(String(p.pair))) {
          // engine-owned orphan with no SL → the CORE RULE applies
          if (noSl) {
            // v21.1.0: flatten fail ho to "FLATTENED" ka jhootha claim nahi —
            // honest error alert (next 12s tick retry karega).
            let flatErr = null;
            try { await _state.port.close({ positionId: p.id }); }
            catch (e) { flatErr = e; }
            if (flatErr) _alertCall(`🚨 ORPHAN ${p.pair} no SL — FLATTEN FAILED: ${String(flatErr?.message || flatErr || '').slice(0, 120)}. Next tick retry; MANUAL VERIFY.`);
            else _alertCall(`🚨 ORPHAN ${p.pair} no SL on exchange — FLATTENED (core rule).`);
          }
        } else if (noSl) {
          // v20.7.12 [H1]: user's MANUAL position — adopt-only + advisory
          _adoptAlertThrottled(p);
        }
      }
      // ghosts (PM has, exchange doesn't) → close in PM journal with honest reason.
      // v20.7.3 FIX: the ghost was only ALERTED, never removed from PM state —
      // it survived forever and re-alerted (Telegram push) every 12s tick.
      // Now: alert once, then forget it from the manager (the exchange is
      // the source of truth; the close already happened off-book — native
      // SL/TP/liq/manual).
      for (const s of pmState) {
        if (!knownIds.has(s.id)) {
          _alertCall(`⚠️ GHOST ${s.pair} in PM journal but not on exchange — closed (likely native SL/TP/liq/manual).`);
          try { _state.positionManager.forget?.(s.id); } catch { /* best-effort */ }
        }
      }
    }
  } catch (e) {
    // v21.1.0 (Phase-2 audit fix #7): reconciler kabhi throw nahi hota, par
    // pehle ye catch bilkul SILENT tha — persistent API failure (bad keys,
    // network down) ke dinon tak reconcile rukta rehta tha aur koi nahi jaanta
    // tha. Ab throttled CRITICAL alert (10 min) + console.error.
    const now = Date.now();
    if (now - (_state._lastTickErrAlert || 0) > 10 * 60_000) {
      _state._lastTickErrAlert = now;
      try { console.error('[reconciler] tick failed:', e); } catch { /* logging best-effort */ }
      _alertCall(`🚨 RECONCILE TICK FAILED: ${String(e?.message || e || '').slice(0, 160)} — exchange sync ruka hai (12s retry chalu). Agar fire lage to /api/exec/kill se L1 laga do.`);
    }
  }
}

function _writeHeartbeat() {
  try {
    _state.heartbeatAt = Date.now();
    const payload = {
      at: _state.heartbeatAt,
      pid: process.pid,
      killLevel: _state.killLevel,
      leader: _state._leaderNode,
      iAmLeader: _state._iAmLeader,
    };
    try { fs.writeFileSync(_state.heartbeatFile, JSON.stringify(payload), 'utf8'); } catch { /* read-only FS — best-effort */ }
  } catch { /* heartbeat best-effort */ }
}

function _checkKillFlagFile() {
  try {
    const flag = fs.existsSync(_state.killFlagFile);
    if (flag && _state.killLevel === 0) {
      // v21.1.1 [audit B1]: persisted LEVEL verbatim restore karo. Pehle yahan
      // hard-coded L3 tha — restart par apni hi likhi hui {level:1} file bhi L3
      // (flatten-everything) ban jaati thi. Operator ne L1 (sirf no-new-entries)
      // set kiya tha, Render redeploy hua, aur engine ne har live position
      // market-close kar di — real-money mass-close jo kisi ne nahi maanga.
      // Unparseable/foreign files (external supervisors) fail-safe L3 hi rehte hain.
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(_state.killFlagFile, 'utf8') || 'null'); } catch { parsed = null; }
      const lvl = Number.isInteger(parsed?.level) && parsed.level >= 1 && parsed.level <= 3
        ? parsed.level
        : 3;
      _state.killLevel = lvl;
      _state.killReason = (parsed && typeof parsed.reason === 'string' && parsed.reason)
        || 'kill-flag file present (external trigger)';
      _state.killSetAt = Number(parsed?.at) > 0 ? Number(parsed.at) : Date.now();
      _state._killFromFlagFile = true;
      _alertCall(lvl >= 3
        ? `🚨 KILL L3 (flag file): ${_state.killFlagFile} — engine disabled, flatten all.`
        : `🛑 KILL L${lvl} RESTORED (restart recovery): ${_state.killReason} — entries blocked, positions managed normally.`);
    } else if (!flag && _state.killLevel >= 1 && _state._killFromFlagFile) {
      // flag cleared externally → resume
      _state.killLevel = 0;
      _state.killReason = null;
      _state.killSetAt = 0;
      _state._killFromFlagFile = false;
      _alertCall('✅ KILL CLEARED (external flag removed). Engine active again.');
    }
  } catch { /* flag check best-effort */ }
}

function _persistKillFlag() {
  try {
    if (_state.killLevel >= 1) {
      fs.writeFileSync(_state.killFlagFile, JSON.stringify({ level: _state.killLevel, reason: _state.killReason, at: _state.killSetAt }), 'utf8');
    }
  } catch { /* persist best-effort */ }
}
function _clearKillFlag() {
  try { if (fs.existsSync(_state.killFlagFile)) fs.unlinkSync(_state.killFlagFile); } catch { /* alert send best-effort */ }
}

function _alertCall(msg) { if (_state.alertSink) try { _state.alertSink(msg); } catch { /* alert send best-effort */ } }

export function __resetReconcilerForTests() {
  if (_state._timer) { try { clearInterval(_state._timer); } catch { /* alert send best-effort */ } }
  _state.armed = false;
  _state.killLevel = 0;
  _state.killReason = null;
  _state.killSetAt = 0;
  _state.heartbeatAt = 0;
  _state.port = null;
  _state.positionManager = null;
  _state.alertSink = null;
  _state._timer = null;
  _state._leaderNode = 'laptop';
  _state._iAmLeader = true;
  _state._adoptAlerts = new Map();
  _state._enginePairs = null;
  _state._enginePairsAt = 0;
}

export function __driveReconcileTickForTests() { return _reconcileTick(); }
/** v20.7.12 test hook — seed/clear the engine-ownership cache directly. */
export function __setEnginePairsForTests(pairs) {
  _state._enginePairs = pairs instanceof Set ? pairs : new Set(Array.isArray(pairs) ? pairs.map(String) : []);
  _state._enginePairsAt = pairs ? Date.now() : 0;
}
export function __setKillLevelForTests(level, reason) {
  _state.killLevel = Math.max(0, Math.min(3, Number(level) || 0));
  _state.killReason = String(reason || 'test');
  _state.killSetAt = Date.now();
}
