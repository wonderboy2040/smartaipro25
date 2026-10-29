// ============================================================
// server/ai/mtfRowLedgerStore.js — v21.25.2 MTF ROW-LEDGER PERSISTENCE
// ------------------------------------------------------------
// WHY THIS EXISTS
//   Phase 3 ka 30-day MTF Direction Scorecard `signalLedger.js` ke
//   in-memory `_mtfScanLedger` par chalta hai. Server restart par wo
//   ledger poora reset ho jata tha, aur `phase0Audit.js` jo
//   `mtf-row-ledger.json` padhta hai us file ko koi writer hi nahi tha
//   (10/19 ka 420-row legacy dump permanently "420/420 unresolved"
//   warning deta tha). Matlab 30-day rolling calibration restart-safe
//   nahi thi aur audit hamesha stale data dikhata tha.
//
// IS MODULE KA SCOPE
//   • active ledger file ko atomic tmp+rename se save karna
//   • boot par current-format rows hydrate karna
//   • purane legacy-shape rows ko `mtf-row-ledger-legacy.json` me
//     archive karna (delete NAHI — audit trail preserved)
//
// signalLedger.js ko PURE hi rakha gaya hai: ye store sirf caller
// (mtfDualBoard) se rows leta/hydrate karta hai. Read-only FS par
// writes best-effort fail hoti hain — memory-only mode jaisa behaviour.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

export const MTF_ROW_LEDGER_FILE = 'mtf-row-ledger.json';
export const MTF_ROW_LEDGER_LEGACY_FILE = 'mtf-row-ledger-legacy.json';
const LEGACY_ARCHIVE_MAX = 5_000;

// v21.27.1 FIX: SMARTAI_DATA_DIR fallback (same contract as mtfAutoLink) —
// hermetic boot ke board scan real ledger file ko overwrite nahi karega.
const _dataDir = () =>
  process.env.MTF_AUTO_DATA_DIR ||
  (process.env.SMARTAI_DATA_DIR ? path.resolve(process.env.SMARTAI_DATA_DIR) : DATA_DIR);
const _file = (name) => path.join(_dataDir(), name);

function _readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(_file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function _writeAtomic(name, payload) {
  try {
    const dir = _dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    try {
      fs.renameSync(tmp, target);
    } catch {
      // Windows par target kisi reader ke open hone par rename EPERM de
      // sakta hai. Direct write fallback (best-effort, data loss se
      // better hai) — next save phir atomic try karega.
      fs.writeFileSync(target, JSON.stringify(payload), 'utf8');
      try { fs.unlinkSync(tmp); } catch { /* tmp already gone */ }
    }
    return true;
  } catch {
    return false;
  }
}

/** Current-format rows `mtf-…` id + resolved boolean rakhte hain; legacy
 *  rows (pre-v21.25 writer) sirf display fields rakhte the. */
function _isCurrentRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (String(row.id || '').startsWith('mtf-') && typeof row.resolved === 'boolean') return true;
  return Number(row.risk) > 0
    && Number(row.peakFavPrice) > 0
    && Number(row.peakAdvPrice) > 0
    && (row.side === 'LONG' || row.side === 'SHORT');
}

function _archiveLegacy(rows, sourceMeta) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  const prev = _readJson(MTF_ROW_LEDGER_LEGACY_FILE, null);
  const merged = new Map();
  for (const row of (Array.isArray(prev?.rows) ? prev.rows : [])) {
    if (row?.id != null) merged.set(String(row.id), row);
  }
  for (const row of rows) {
    if (row?.id != null) merged.set(String(row.id), row);
  }
  const all = [...merged.values()];
  const payload = {
    archivedAt: Date.now(),
    source: MTF_ROW_LEDGER_FILE,
    count: all.length,
    // Purani rows ka original lastLogAt/lastResolveAt bhi preserve karo.
    sourceLastLogAt: sourceMeta?.lastLogAt ?? null,
    sourceLastResolveAt: sourceMeta?.lastResolveAt ?? null,
    rows: all.length > LEGACY_ARCHIVE_MAX ? all.slice(-LEGACY_ARCHIVE_MAX) : all,
  };
  return _writeAtomic(MTF_ROW_LEDGER_LEGACY_FILE, payload);
}

/**
 * Load the active MTF row ledger.
 * Legacy-shape rows are archived once and removed from the active file;
 * current-format rows are returned for `hydrateMtfLedger()`.
 *
 * @returns {{ rows: Array, lastLogAt: number|null, lastResolveAt: number|null, legacyArchived: number }}
 */
export function loadMtfRowLedger() {
  const raw = _readJson(MTF_ROW_LEDGER_FILE, null);
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.rows) ? raw.rows : []);
  const lastLogAt = Number(raw?.lastLogAt) > 0 ? Number(raw.lastLogAt) : null;
  const lastResolveAt = Number(raw?.lastResolveAt) > 0 ? Number(raw.lastResolveAt) : null;

  const current = [];
  const legacy = [];
  for (const row of rows) {
    if (_isCurrentRow(row)) current.push(row);
    else legacy.push(row);
  }

  if (legacy.length > 0) {
    // Archive first — agar archive write fail ho to active file ko
    // overwrite NAHI karte (legacy rows lost na hon).
    const archived = _archiveLegacy(legacy, { lastLogAt, lastResolveAt });
    if (archived) {
      _writeAtomic(MTF_ROW_LEDGER_FILE, {
        rows: current,
        lastLogAt,
        lastResolveAt,
        legacyArchivedAt: Date.now(),
      });
    }
  }

  return { rows: current, lastLogAt, lastResolveAt, legacyArchived: legacy.length };
}

/**
 * Save the active ledger. Caller decides `force` (new row / resolution);
 * otherwise writes are throttled to once per 30s so MFE/MAE updates do
 * not hammer the disk on every board scan.
 *
 * @param {{ rows: Array, lastLogAt?: number|null, lastResolveAt?: number|null }} snapshot
 * @param {{ force?: boolean, now?: number, minIntervalMs?: number }} opts
 * @returns {boolean} true when written (or no write needed)
 */
export function saveMtfRowLedger(snapshot, { force = false, now = Date.now(), minIntervalMs = 30_000 } = {}) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : null;
  if (!rows) return false;
  const t = Number(now) > 0 ? Number(now) : Date.now();
  const last = Number(saveMtfRowLedger._lastWriteAt) || 0;
  if (!force && last > 0 && t - last < Math.max(1_000, Number(minIntervalMs) || 30_000)) return true;
  const ok = _writeAtomic(MTF_ROW_LEDGER_FILE, {
    rows,
    lastLogAt: Number(snapshot?.lastLogAt) > 0 ? Number(snapshot.lastLogAt) : null,
    lastResolveAt: Number(snapshot?.lastResolveAt) > 0 ? Number(snapshot.lastResolveAt) : null,
  });
  if (ok) saveMtfRowLedger._lastWriteAt = t;
  return ok;
}

/** Test hook — forget throttle state (does not touch files). */
export function __resetMtfRowLedgerStoreForTests() {
  saveMtfRowLedger._lastWriteAt = 0;
}
