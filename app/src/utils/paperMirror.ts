// ============================================================
// paperMirror — device-side durability for paper-trade history
// ------------------------------------------------------------
// WHY: the live site runs on Render's FREE plan, whose filesystem is
// ephemeral — every spin-down/restart re-checks-out the repo and
// wipes server/data/paper-trades.json. The paper-trading history
// silently reset to 0.
//
// HOW: the browser keeps a full copy of the trade history (open +
// closed trades) in IndexedDB (localStorage fallback). After every
// history fetch we compare counts: if the SERVER lost trades but
// this device still has them, we POST the mirror back to
// /api/intraday-paper/restore and the engine rebuilds its state.
// Zero setup — works on every device where the tab was opened.
// ============================================================
import { appDB } from './db';
import type { PaperTrade } from '../components/intraday/types';

const MIRROR_KEY = 'paper_mirror_v1';
const MIRROR_MAX_TRADES = 500;
const RESTORE_THROTTLE_MS = 60_000;

export interface PaperMirror {
  open: PaperTrade[];
  closed: PaperTrade[];
  savedAt: number;
}

let _lastRestoreAttempt = 0;

async function saveMirror(open: PaperTrade[], closed: PaperTrade[]): Promise<void> {
  try {
    const mirror: PaperMirror = {
      open: (open || []).slice(0, 20),
      closed: (closed || []).slice(0, MIRROR_MAX_TRADES),
      savedAt: Date.now(),
    };
    await appDB.setUserPreference(MIRROR_KEY, mirror);
  } catch { /* storage quota/private mode — mirror is best-effort */ }
}

async function getMirror(): Promise<PaperMirror | null> {
  try {
    const m = await appDB.getUserPreference<PaperMirror | null>(MIRROR_KEY, null);
    if (!m || !Array.isArray(m.closed)) return null;
    return m;
  } catch {
    return null;
  }
}

function mirrorCount(m: PaperMirror | null): number {
  if (!m) return 0;
  return (m.closed?.length || 0) + (m.open?.length || 0);
}

/**
 * Compare the device mirror with the server's current totals. Returns
 * the mirror payload when the server appears WIPED (knows fewer
 * trades than this device saw last time), else null.
 */
function shouldRestore(
  m: PaperMirror | null,
  serverClosedCount: number,
  serverOpenCount: number,
): PaperTrade[] | null {
  if (!m) return null;
  const serverTotal = serverClosedCount + serverOpenCount;
  const deviceTotal = mirrorCount(m);
  if (deviceTotal <= serverTotal) return null;            // server is fine
  const payload = [...(m.closed || []), ...(m.open || [])];
  if (payload.length === 0) return null;
  if (Date.now() - _lastRestoreAttempt < RESTORE_THROTTLE_MS) return null;
  return payload;
}

async function postRestore(trades: PaperTrade[]): Promise<{ ok: boolean; restored?: number }> {
  _lastRestoreAttempt = Date.now();
  try {
    const { apiFetch } = await import('./api');
    const res = await apiFetch('/api/intraday-paper/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trades }),
      signal: AbortSignal.timeout(12000),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j?.ok) return { ok: true, restored: j.restored || 0 };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * One-shot sync after a history fetch: update the device mirror, and
 * if the server lost trades, restore them from the mirror.
 * Returns true when a restore actually happened (caller refreshes).
 *
 * v20.9.1 [H2]: COMPARE-BEFORE-SAVE — pehle saveMirror pehle chalta tha,
 * jo mirror ko EXACTLY wahi arrays overwrite kar deta tha jo hum compare
 * karne wale the → deviceTotal <= serverTotal HAMESHA true → restore
 * path DEAD CODE tha (Render wipe pe bhi "history reset to 0" hi dikhta
 * tha — wahi incident jiske liye ye module bana tha). Ab PURANA mirror
 * pehle read hota hai, restore decision US se banta hai, aur naya server
 * state sirf restore ke BAAD (ya kisi restore ki zaroorat na hone par)
 * mirror me save hota hai.
 */
export async function syncMirrorWithServer(
  open: PaperTrade[],
  historyTrades: PaperTrade[],
): Promise<boolean> {
  const previous = await getMirror();
  const serverClosed = historyTrades.length;
  const serverOpen = open.length;
  const payload = shouldRestore(previous, serverClosed, serverOpen);
  if (payload) {
    const r = await postRestore(payload);
    if (r.ok && (r.restored || 0) > 0) {
      // restore hua — caller turant re-fetch karta hai (PaperTradePanel
      // loadHistory); mirror ko in STALE (wiped) params se overwrite KARNA
      // MANA hai. Purana mirror hi rakho (ab server ke recovered state se
      // match karta hai); agli loadHistory fresh state save kar degi.
      return true;
    }
    // restore fail — PURANA mirror untouched rakho (ye hi to asset hai;
    // overwrite kar dete to wipe ko "accept" kar liya hota).
    return false;
  }
  await saveMirror(open, historyTrades);
  return false;
}
