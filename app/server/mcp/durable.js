// ============================================================
// server/mcp/durable.js — restart-safe persistence for MCP state
// ------------------------------------------------------------
// PROBLEM (user-reported): INDMoney OAuth tokens + CoinDCX API
// keys + the synced portfolio snapshot live in server/data/*.json
// — and Render's free tier ships an EPHEMERAL filesystem. Every
// spin-down / restart / redeploy wipes those files, so the user
// has to re-connect INDMoney and re-paste CoinDCX keys again and
// again (deleting browser cookies only forces a PIN re-entry, but
// Render restarts silently destroy the SERVER-side credentials).
//
// FIX: mirror the state files to GitHub (same durable mechanism
// paper-trading already uses — backup.js pushes to a non-deploy
// `data-backup` branch) with ONE addition: the payload is
// ENCRYPTED with AES-256-GCM before it leaves the machine, so a
// public repo backup branch can never leak keys or holdings.
//
// Key resolution (first that works):
//   1. DURABLE_KEY env (recommended, >=16 chars)
//   2. scrypt(APP_PIN + ':' + API_TOKEN) — both already exist in
//      the Render env, so durable storage works with ZERO extra
//      setup on the live deployment.
//   3. disabled (module is a silent no-op).
//
// API:
//   durablePut(file, data)      — encrypt + schedule remote push
//   durableBootRestore(file)    — pull + decrypt + hydrate local
//                                 file when missing/older
//   durableBootRestoreAll()     — boot wiring for ALL mcp files
//   durableStatus()             — for the connection panels
// Every path is best-effort and never throws into a route.
// ============================================================
import crypto from 'node:crypto';
import { scheduleBackup, restoreBackup, backupConfigured } from '../lib/backup.js';
import { loadJSON, saveJSON } from '../lib/store.js';

const KEY_MIN_LEN = 16;
const _log = (msg) => console.log(`[mcp/durable] ${msg}`);

// ---------------- key material ----------------
let _keyCache = null; // Buffer(32) | false (disabled)
function durableKey() {
  if (_keyCache !== null) return _keyCache;
  const explicit = process.env.DURABLE_KEY;
  if (explicit && explicit.length >= KEY_MIN_LEN) {
    _keyCache = crypto.scryptSync(explicit, 'smartai-durable-v1', 32);
    return _keyCache;
  }
  const pin = process.env.APP_PIN || '';
  const svc = process.env.API_TOKEN || '';
  if (pin && svc && (pin + svc).length >= KEY_MIN_LEN) {
    // Derived from two existing server-side secrets — zero-config.
    _keyCache = crypto.scryptSync(`${pin}:${svc}`, 'smartai-durable-v1', 32);
    return _keyCache;
  }
  _keyCache = false; // disabled
  return _keyCache;
}

export function durableConfigured() {
  return backupConfigured() && !!durableKey();
}

export function durableStatus() {
  const key = durableKey();
  return {
    configured: !!(backupConfigured() && key),
    keySource: process.env.DURABLE_KEY ? 'DURABLE_KEY' : (key ? 'derived(APP_PIN+API_TOKEN)' : 'none'),
  };
}

// ---------------- AES-256-GCM envelope ----------------
export function encryptJSON(obj) { // exported for tests
  const key = durableKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
    ts: Date.now(),
  };
}

export function decryptJSON(env) { // exported for tests
  const key = durableKey();
  if (!key || !env || env.alg !== 'aes-256-gcm' || !env.iv || !env.tag || !env.ct) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch { return null; } // wrong key / tampered — treat as missing
}

// ---------------- push (write-through) ----------------
export function durablePut(file, data) {
  try {
    if (!durableConfigured()) return false;
    const envelope = encryptJSON(data);
    if (!envelope) return false;
    scheduleBackup(file, envelope);
    return true;
  } catch (e) {
    _log(`put ${file} failed: ${e?.message || e}`);
    return false;
  }
}

// ---------------- boot restore ----------------
const _restoring = new Set();
/**
 * Pull the encrypted backup for `file`, decrypt, and hydrate the LOCAL
 * file when it is missing, empty, or older than the remote copy.
 * Returns the restored object or null. Concurrent calls coalesce.
 */
export async function durableBootRestore(file, opts = {}) {
  try {
    if (!durableConfigured()) return null;
    if (_restoring.has(file)) return null;
    _restoring.add(file);
    const local = loadJSON(file, null);
    const localTs = opts.localTs ? opts.localTs(local) : 0;
    const localUsable = opts.isUsable ? opts.isUsable(local) : !!local;

    const remote = await restoreBackup(file);
    if (!remote) return null;
    const plain = decryptJSON(remote);
    if (!plain) {
      _log(`restore ${file}: remote blob undecryptable (key change?) — ignoring`);
      return null;
    }
    const remoteTs = opts.remoteTs ? opts.remoteTs(plain) : (remote.ts || 0);
    if (localUsable && localTs >= remoteTs) return null; // local is fine
    saveJSON(file, plain);
    _log(`restored ${file} from durable backup`);
    return plain;
  } catch (e) {
    _log(`restore ${file} failed: ${e?.message || e}`);
    return null;
  } finally {
    _restoring.delete(file);
  }
}

/**
 * Boot wiring for every MCP state file. Credentials first (they gate
 * every sync), then the asset snapshot, then the symbol cache.
 * Fire-and-forget from index.js — GitHub round-trip is ~500ms-2s and
 * the first authenticated /assets hit lands after hydration anyway.
 *
 * v10.3.1 CRITICAL ADDITION — TRADING STATE (user-reported bug:
 * "site refresh par saare positions clear ho rahe hai"):
 * Render free-tier spin-downs wipe server/data/ — and the trading
 * JOURNAL was durablePut'd on every save but NEVER restored on boot,
 * so every restart silently zeroed open paper/live positions, the
 * risk config and both agents' quota/log state. The same files now
 * hydrate FIRST (before any route or watcher can write an empty
 * journal over a good backup). The intraday desk's track-record and
 * journal state ride the same encrypted path.
 */
export async function durableBootRestoreAll() {
  if (!durableConfigured()) {
    _log(!backupConfigured()
      ? 'NOT configured — set GITHUB_BACKUP_TOKEN + GITHUB_BACKUP_REPO (optionally DURABLE_KEY) to make credentials restart-safe'
      : 'backup repo configured but no encryption key (DURABLE_KEY or APP_PIN+API_TOKEN) — disabled');
    return {};
  }
  const restored = {};

  // 0) TRADING STATE FIRST — the journal is the one file a live route
  // could conceivably write during boot (watcher tick, agent resume).
  // Hydrating it before anything else runs removes that race. ts on
  // the journal is the max entry/position timestamp (monotonic-ish);
  // agent/config/state files carry their own updatedAt / ts fields.
  const maxTs = (arr) => (Array.isArray(arr) && arr.length
    ? arr.reduce((m, x) => { const t = Number(x?.ts || x?.openedAt || x?.closedAt) || 0; return t > m ? t : m; }, 0)
    : 0);
  const journal = await durableBootRestore('ai-trading-journal.json', {
    isUsable: (s) => !!(s && (Array.isArray(s.positions) || Array.isArray(s.entries))
      && ((s.positions || []).length > 0 || (s.entries || []).length > 0)),
    localTs: (s) => Math.max(maxTs(s?.positions), maxTs(s?.entries)),
    remoteTs: (s) => Math.max(maxTs(s?.positions), maxTs(s?.entries)),
  });
  if (journal) restored.tradingJournal = true;
  // v21.1.1 [audit A4]: ai-signal-ledger.json ab boot-restore hota hai.
  // Ledger save pe durablePut karta tha par restore kabhi nahi hota tha —
  // ephemeral-FS (Render) restart pe Phase-4 state (settled trades,
  // kill-rule windows, go-live readiness counter) SILENTLY zero ho jaata
  // tha. Fail-closed tha (unsafe nahi) par "100 paper trades" achievement
  // evaporate ho jaata tha.
  const ledger = await durableBootRestore('ai-signal-ledger.json', {
    isUsable: (l) => Array.isArray(l?.entries) && l.entries.length > 0,
    localTs: (l) => maxTs(l?.entries) || Number(l?.updatedAt) || 0,
    remoteTs: (l) => maxTs(l?.entries) || Number(l?.updatedAt) || 0,
  });
  if (ledger) {
    restored.signalLedger = true;
    // ledger.js module-eval capture drop (same pattern as agents below)
    try {
      const mod = await import('../ai/ledger.js');
      if (typeof mod.__reloadLedgerForBoot === 'function') mod.__reloadLedgerForBoot();
    } catch { /* best-effort */ }
  }
  const tcfg = await durableBootRestore('ai-trading-config.json', {
    isUsable: (s) => !!(s && typeof s === 'object' && Object.keys(s).length),
    localTs: (s) => s?.liveConfirmedAt || s?.updatedAt || 0,
    remoteTs: (s) => s?.liveConfirmedAt || s?.updatedAt || 0,
  });
  if (tcfg) restored.tradingConfig = true;
  // Both agents' quota/log/exposure state + their configs (the
  // journal accounting is source-scoped, but the RUN state — started/
  // stopped, today's trade count, ring log — lived only on the
  // ephemeral disk before this restore existed).
  for (const [file, key, tsKey] of [
    ['ai-agent-state.json', 'cryptoAgentState', 'ts'],
    ['ai-agent-config.json', 'cryptoAgentConfig', 'ts'],
    ['india-agent-state.json', 'indiaAgentState', 'ts'],
    ['india-agent-config.json', 'indiaAgentConfig', 'ts'],
    // Intraday desk accountability (v10.3.1): the signal track-record
    // and the AI trade journal were plain saveJSON before — restarts
    // reset the track record to zero. They durablePut on save now.
    ['tracked-signals.json', 'trackedSignals', 'ts'],
    ['trade-journal.json', 'tradeJournal', 'ts'],
  ]) {
    const st = await durableBootRestore(file, {
      isUsable: (s) => !!(s && typeof s === 'object'
        && (Array.isArray(s.signals) || Array.isArray(s.entries) || Array.isArray(s.trades)
          || Object.keys(s).some(k => !['signals', 'entries', 'trades'].includes(k)))),
      localTs: (s) => Math.max(maxTs(s?.signals), maxTs(s?.entries), Number(s?.updatedAt) || 0, Number(s?.[tsKey]) || 0),
      remoteTs: (s) => Math.max(maxTs(s?.signals), maxTs(s?.entries), Number(s?.updatedAt) || 0, Number(s?.[tsKey]) || 0),
    });
    if (st) restored[key] = true;
  }
  // v10.3.1: the agent/accountability modules captured their state at
  // MODULE-EVAL time — before this restore wrote the disk files. Drop
  // those in-memory copies so the next read sees the hydrated disk
  // (same pattern the INDMoney restore uses). Dynamic imports — no
  // static cycle with agent.js / indiaAgent.js.
  for (const [mod, hook] of [
    ['../ai/agent.js', '__reloadStateForBoot'],
    ['../ai/indiaAgent.js', '__reloadStateForBoot'],
    ['../intraday/trackRecord.js', '__reloadTrackRecordForBoot'],
    ['../intraday/journal.js', '__reloadJournalForBoot'],
  ]) {
    try {
      const m = await import(mod);
      if (typeof m?.[hook] === 'function') m[hook]();
    } catch { /* non-fatal */ }
  }

  // 1) INDMoney OAuth tokens.
  const indm = await durableBootRestore('mcp-indmoney.json', {
    isUsable: (s) => !!(s && s.tokens && s.tokens.accessToken),
    localTs: (s) => s?.tokens?.obtainedAt || s?.connectedAt || 0,
    remoteTs: (s) => s?.tokens?.obtainedAt || s?.connectedAt || 0,
  });
  if (indm) {
    restored.indmoney = true;
    try {
      // Drop any in-memory copy so the next state() re-reads the disk file.
      const mod = await import('./indmoney.js');
      if (typeof mod.__dropInMemoryStateForBoot === 'function') mod.__dropInMemoryStateForBoot();
    } catch { /* non-fatal */ }
  }
  // 2) CoinDCX API credentials (read fresh from disk on every call —
  //    restoring the file is sufficient, no in-memory copy exists).
  const cdcx = await durableBootRestore('mcp-coindcx.json', {
    isUsable: (s) => !!(s && s.apiKey && s.secret),
    localTs: (s) => s?.connectedAt || 0,
    remoteTs: (s) => s?.connectedAt || 0,
  });
  if (cdcx) restored.coindcx = true;
  // 2.5) CoinDCX manual cost basis (v6.1 FIX — user-reported): the
  // per-coin invested amounts were durablePut'd on save but were
  // MISSING from this boot list, so a Render restart/redeploy wiped
  // the ephemeral file and the crypto P&L silently reverted to
  // "n/a" — looking exactly like "Set Basis saved nahi hua".
  // Restored BEFORE the portfolio snapshot (rows embed the basis at
  // sync time). File shape: { basis: {...}, updatedAt } (legacy flat
  // { BTC: 123 } backups from <= v6.0 are normalized on load).
  const cdBasis = await durableBootRestore('mcp-coindcx-basis.json', {
    isUsable: (s) => {
      const coins = (s && typeof s === 'object' && s.basis && typeof s.basis === 'object') ? s.basis : s;
      return !!(coins && typeof coins === 'object' && Object.keys(coins).length);
    },
    localTs: (s) => s?.updatedAt || 0,
    remoteTs: (s) => s?.updatedAt || 0,
  });
  if (cdBasis) restored.coindcxBasis = true;
  // 3) The asset-table snapshot (rows + hidden keys survive restarts).
  const pf = await durableBootRestore('mcp-portfolio.json', {
    isUsable: (s) => !!(s && Array.isArray(s.assets) && s.assets.length),
    localTs: (s) => s?.syncedAt || 0,
    remoteTs: (s) => s?.syncedAt || 0,
  });
  if (pf) restored.portfolio = true;
  // 4) Symbol-resolution cache (kills re-lookup latency after boot).
  // Freshness via the max per-entry ts — without it this slot was the
  // ONLY restore without a timestamp comparison, so a usable local
  // cache was unconditionally overwritten by the (possibly older)
  // remote copy on same-disk restarts, reverting resolutions made
  // after the last backup push.
  const symMaxTs = (s) => {
    if (!s?.map || typeof s.map !== 'object') return 0;
    let m = 0;
    for (const v of Object.values(s.map)) {
      const t = v?.ts || 0;
      if (t > m) m = t;
    }
    return m;
  };
  const syms = await durableBootRestore('mcp-symbol-cache.json', {
    isUsable: (s) => !!(s && s.map && Object.keys(s.map).length),
    localTs: symMaxTs,
    remoteTs: symMaxTs,
  });
  if (syms) {
    restored.symbols = true;
    try {
      const mod = await import('./symbols.js');
      if (typeof mod.__dropSymbolCacheForBoot === 'function') mod.__dropSymbolCacheForBoot();
    } catch { /* non-fatal */ }
  }
  // 5) Tapetide OAuth tokens (v4.7 — India research desk).
  const tpt = await durableBootRestore('mcp-tapetide.json', {
    isUsable: (s) => !!(s && s.tokens && s.tokens.accessToken),
    localTs: (s) => s?.tokens?.obtainedAt || s?.connectedAt || 0,
    remoteTs: (s) => s?.tokens?.obtainedAt || s?.connectedAt || 0,
  });
  if (tpt) {
    restored.tapetide = true;
    try {
      const mod = await import('./tapetide.js');
      if (typeof mod.__dropInMemoryStateForBoot === 'function') mod.__dropInMemoryStateForBoot();
    } catch { /* non-fatal */ }
  }
  // 6) App settings (v6.1 — the multi-device fix): the Portfolio tab's
  // server-side calibrations (usdAppRate "Match App" FX etc.). Without
  // this restore a restart would drop the user back to live-FX numbers
  // on every device — the exact "price alag" regression reported.
  const st = await durableBootRestore('mcp-settings.json', {
    isUsable: (s) => !!(s && s.settings && typeof s.settings === 'object' && Object.keys(s.settings).length),
    localTs: (s) => s?.updatedAt || 0,
    remoteTs: (s) => s?.updatedAt || 0,
  });
  if (st) restored.settings = true;
  // 7) AI Terminal secrets (v6.5): Telegram bot token/chat id + AI
  // Council keys — typed in the app, stored server-side. Without this
  // restore a Render restart would silently kill alerts and the 9th
  // model until the user re-entered everything.
  const aiSec = await durableBootRestore('ai-secrets.json', {
    isUsable: (s) => !!(s && s.secrets && typeof s.secrets === 'object' && Object.keys(s.secrets).length),
    localTs: (s) => s?.updatedAt || 0,
    remoteTs: (s) => s?.updatedAt || 0,
  });
  if (aiSec) restored.aiSecrets = true;
  // 8) Dhan broker credentials (v6.5 — India execution venue). Same
  // restart-safety as the CoinDCX keys: connected ONCE, stays connected
  // across redeploys.
  const dhan = await durableBootRestore('mcp-dhan.json', {
    isUsable: (s) => !!(s && s.clientId && s.accessToken),
    localTs: (s) => s?.connectedAt || 0,
    remoteTs: (s) => s?.connectedAt || 0,
  });
  if (dhan) restored.dhan = true;
  const keys = Object.keys(restored);
  if (keys.length) _log(`boot restore complete: ${keys.join(', ')}`);
  return restored;
}

// ---------------- test hooks ----------------
export function __resetDurableForTests() {
  _keyCache = null;
  _restoring.clear();
}
