// ============================================================
// ai/mlHealth.js — CACHED ml-service REACHABILITY PROBE (v18.1)
// ------------------------------------------------------------
// /health previously only reported the IN-PROCESS ml engine. A dead
// Python ml-service (the meta-learner + local HF AI) was invisible.
// This probe pings ML_SERVICE_URL/health with a short timeout and
// caches the result for 30s so the hot /health path never stacks
// network latency. Never throws — unreachable simply means
// { reachable: false }.
// ============================================================

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 1200;

let _cached = null;      // { reachable, latencyMs, detail, checkedAt }
let _inFlight = null;    // coalesce concurrent probes

const _base = () =>
  // v21.11.0 PORT-COLLISION FIX: 8000 → 8100 (8000 pehle Laya ka port tha — v21.14 me removed).
  String(process.env.ML_SERVICE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');

async function _probe() {
  const t0 = Date.now();
  try {
    const r = await fetch(`${_base()}/health`, {
      // /health is intentionally unauthenticated in ml-service — no
      // X-API-Key needed (see app/main.py middleware exemptions).
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => ({}));
    return {
      reachable: true,
      latencyMs: Date.now() - t0,
      // v21.13.x recheck (M7): Python /health returns {"status":"ok"}
      // (j.ok kabhi nahi tha) — the detail was permanently "ok-ish (...)".
      // Dono shapes accept: {ok:true} ya {status:'ok'}.
      detail: (j?.ok === true || j?.status === 'ok') ? 'ok' : `ok-ish (${JSON.stringify(j).slice(0, 120)})`,
      version: j?.version || null,
      checkedAt: Date.now(),
    };
  } catch (e) {
    return {
      reachable: false,
      latencyMs: Date.now() - t0,
      detail: e?.name === 'TimeoutError' ? 'timeout' : String(e?.message || e).slice(0, 160),
      checkedAt: Date.now(),
    };
  }
}

/** Cached probe — max one network hit per PROBE_TTL_MS. */
export function mlServiceHealth({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cached && now - _cached.checkedAt < PROBE_TTL_MS) return _cached;
  if (!_inFlight) {
    _inFlight = _probe()
      .then((res) => { _cached = res; return res; })
      .catch(() => { _cached = { reachable: false, detail: 'probe crashed', checkedAt: Date.now() }; })
      .finally(() => { _inFlight = null; });
  }
  // return the stale cache immediately while the refresh rides in the background
  return _cached || { reachable: false, detail: 'probing…', checkedAt: now };
}

/** Test hook. */
export function __resetMlHealthCacheForTests() { _cached = null; }
