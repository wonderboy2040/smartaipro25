// ============================================================
// lib/backup — RE-EXPORT SHIM (v11.4 recheck)
// ------------------------------------------------------------
// HISTORY OF THIS BUG: two near-identical copies of the GitHub
// Contents-API backup module existed (this one + intraday/backup.js).
// The v11.3 timeout/retry patch landed ONLY in intraday/backup.js —
// durable.js (journal / track-record / near-miss / gate-override —
// every encrypted durable file) kept importing THIS stale 10s /
// zero-retry copy, and the production log kept showing
// "[backup] head council-nearmiss.json failed: The operation was
// aborted due to timeout" after the fix "shipped".
//
// One implementation now lives in server/intraday/backup.js (15s
// budget + HEAD retries + branch bootstrap + bounded push retries);
// this module re-exports it so both import paths share ONE instance
// (one serialized queue, one set of pacing maps — no divergence is
// even possible). vi.mock('../server/lib/backup.js') keeps working:
// the mock replaces this module's exports wholesale.
// ============================================================
export {
  backupConfigured,
  scheduleBackup,
  restoreBackup,
  flushBackupNow, // v12.7: shutdown flush rides the same shared instance
} from '../intraday/backup.js';
