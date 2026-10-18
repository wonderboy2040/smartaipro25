// ============================================================
// server/bots/botState.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §10.3 state contract:
//   state/<bot>.json          atomic (tempfile -> rename)
//   state/<bot>.events.jsonl  append-only decision/trade log
//   state/STOP_<bot>          kill switch — presence = STOP
// Dashboard sirf inhe padhta hai; snapshot `bot` field se identify
// hota hai. Kill switch bina deploy ke kaam karta hai (har cycle
// me file check) + UI button + Telegram command isse hi toggle
// karte hain.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const MAX_EVENTS = 400; // journal-400 convention (repo-wide)

function botFile(stateDir, bot, suffix = '.json') {
  const safe = String(bot).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stateDir, `${safe}${suffix}`);
}

/** Atomic JSON write: tempfile in the SAME dir + rename (crash-safe). */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/** Load <bot>.json (null when absent/corrupt — caller starts fresh). */
export function loadBotState(stateDir, bot) {
  const p = botFile(stateDir, bot);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Save <bot>.json atomically. Refuses to persist without `bot` field. */
export function saveBotState(stateDir, bot, state) {
  if (!bot || typeof bot !== 'string') throw new Error('botState: bot id required');
  atomicWriteJson(botFile(stateDir, bot), { ...state, bot, updatedAt: new Date().toISOString() });
}

/** Append one event to <bot>.events.jsonl (bounded tail compaction). */
export function appendEvent(stateDir, bot, evt) {
  const p = botFile(stateDir, bot, '.events.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = JSON.stringify({ ...evt, bot, at: evt.at || new Date().toISOString() }) + '\n';
  fs.appendFileSync(p, line);
  _eventsCache.delete(p); // v20.8.2: same-process invalidation
  compactIfNeeded(p);
}

function compactIfNeeded(p) {
  try {
    const st = fs.statSync(p);
    if (st.size < 2 * 1024 * 1024) return; // <2MB: fine
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(-MAX_EVENTS);
    // v20.8.1 FIX (L): pid-suffixed tmp — matches atomicWriteJson's
    // cross-process safety pattern.
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.join('\n') + '\n');
    fs.renameSync(tmp, p);
    _eventsCache.delete(p); // v20.8.2: compaction rewrote the file
  } catch { /* compaction is best-effort */ }
}

// v20.8.2 FIX (M — event-loop freeze class): the SSE stream pushes events
// every 5s PER CLIENT (cap 8) and each push used to readFileSync + split
// the WHOLE .events.jsonl (up to 2MB just before compaction) for EVERY
// enabled bot — the same synchronous-parse storm the v20.7.12 lib/store
// journal fix killed. mtime+size cache with clone-on-hit; stat-mismatch
// (external writer / CLI / compaction) re-reads.
const _eventsCache = new Map(); // file path -> { mtimeMs, size, events }

/** Read last N events (dashboard decision stream). */
export function readEvents(stateDir, bot, limit = 100) {
  const p = botFile(stateDir, bot, '.events.jsonl');
  if (!fs.existsSync(p)) return [];
  let cached = _eventsCache.get(p);
  try {
    const st = fs.statSync(p);
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      const events = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      cached = { mtimeMs: st.mtimeMs, size: st.size, events };
      if (_eventsCache.size >= 64) _eventsCache.clear(); // bounded
      _eventsCache.set(p, cached);
    }
  } catch {
    cached = cached || { mtimeMs: 0, size: 0, events: [] };
  }
  // clone-on-hit: callers must never share/mutate the cached objects
  return cached.events.slice(-Math.max(1, limit)).map(e => ({ ...e }));
}

// ---------------- kill switch (STOP_<bot> presence) ----------------

export function killSwitchFile(stateDir, bot) {
  return botFile(stateDir, 'STOP_' + bot, '');
}

export function killSwitchActive(stateDir, bot) {
  return fs.existsSync(killSwitchFile(stateDir, bot));
}

export function setKillSwitch(stateDir, bot, on, note = '') {
  const p = killSwitchFile(stateDir, bot);
  if (on) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ bot, at: new Date().toISOString(), note }));
  } else if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
  return killSwitchActive(stateDir, bot);
}

/** All active kill switches in a state dir (for /api/bots/status).
 *  v20.8.1 FIX (L): STOP_ALL's 'ALL' pseudo-bot is excluded — it was
 *  returned as if it were a real bot id. */
export function activeKillSwitches(stateDir) {
  try {
    return fs.readdirSync(stateDir).filter(f => f.startsWith('STOP_') && f !== 'STOP_ALL').map(f => f.slice(5));
  } catch { return []; }
}

/**
 * Global pause file (Telegram /stop all, UI master switch).
 * Presence blocks EVERY bot.
 */
export function globalPauseActive(stateDir) {
  return fs.existsSync(path.join(stateDir, 'STOP_ALL'));
}
