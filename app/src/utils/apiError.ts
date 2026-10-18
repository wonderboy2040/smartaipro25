// ============================================================
// src/utils/apiError.ts — UNIFIED API ERROR EXTRACTION (v10.10)
// ------------------------------------------------------------
// THE "[object Object]" KILLER.
//
// The backend has TWO error response contracts live in production:
//   1. jsonError() (server/index.js):  { error: { message, correlationId } }
//   2. flat routes (india-agent etc):   { ok: false, error: 'string' }
//   3. ml-service / FastAPI proxies:    { detail: 'string' | {...} }
//   4. raw fetch/AbortError:           Error instances
//
// Any `new Error(data?.error)` or `${r.error}` against contract #1
// coerces the object to "[object Object]" — the exact bug the desk
// saw on the SOL deep-dive prompt in BOTH the India Intraday and
// CoinDCX tabs. This util unwraps EVERY shape into a clean human
// string, appends the server correlationId when present (pro-level
// debuggability — the same id is in the server log line), and never
// throws. Pure function → fully unit-testable (test/apiError.test.ts).
// ============================================================

/** Max chars of the safe-JSON last resort (long HTML/proxy pages are noise). */
const MAX_FALLBACK_JSON = 180;

const isNonEmpty = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Extract a human-readable message from ANY error payload shape.
 * Order: string → Error → {error:{message}} → {error:string} →
 * {message} → {detail} → {error:{error:{message}}} (nested) →
 * truncated safe-JSON → fallback.
 */
export function extractApiError(payload: unknown, fallback = 'Request failed'): string {
  try {
    if (isNonEmpty(payload)) return payload.trim();
    if (payload instanceof Error) return payload.message || fallback;

    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;

      // 1. jsonError() contract — { error: { message, correlationId } }
      const nestedErr = p.error;
      if (nestedErr && typeof nestedErr === 'object') {
        const m = (nestedErr as Record<string, unknown>).message;
        if (isNonEmpty(m)) return m.trim();
        // deeply nested ({ error: { error: { message } } } proxies)
        const deep = extractApiError(nestedErr, '');
        if (isNonEmpty(deep)) return deep;
      }
      // 2. flat contract — { error: 'string' }
      if (isNonEmpty(nestedErr)) return (nestedErr as string).trim();
      // 3. { message } — generic HTTP-ish body
      if (isNonEmpty(p.message)) return p.message.trim();
      // 4. { detail } — FastAPI / ml-service
      if (isNonEmpty(p.detail)) return p.detail.trim();
      if (p.detail && typeof p.detail === 'object') {
        const dm = (p.detail as Record<string, unknown>).message;
        if (isNonEmpty(dm)) return dm.trim();
      }
      // 5. last resort — truncated safe JSON (better than [object Object])
      try {
        const s = JSON.stringify(nestedErr ?? p);
        if (isNonEmpty(s) && s !== '{}' && s !== 'null') {
          return s.length > MAX_FALLBACK_JSON ? `${s.slice(0, MAX_FALLBACK_JSON)}…` : s;
        }
      } catch { /* circular — fall through */ }
    }
  } catch { /* never throw from an error handler */ }
  return fallback;
}

/**
 * The server-side jsonError() stamps a correlationId on every error
 * response; the same id is logged server-side. Surfacing it in the UI
 * ("ref: ab12cd") turns "kuch error aaya" bug reports into a one-grep
 * server lookup. Returns '' when absent.
 */
export function extractApiErrorRef(payload: unknown): string {
  try {
    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      const cid = p.correlationId
        ?? (p.error && typeof p.error === 'object' ? (p.error as Record<string, unknown>).correlationId : null);
      if (isNonEmpty(cid)) return cid.trim().slice(0, 12);
    }
  } catch { /* never throw */ }
  return '';
}

/**
 * Combined one-liner: message + optional (ref: id) suffix.
 * `describeApiError(data, res.status, fallback)` → the exact string a
 * chat panel should render for a failed /api call.
 */
export function describeApiError(payload: unknown, status?: number, fallback?: string): string {
  const base = extractApiError(payload, fallback || (status ? `request failed (${status})` : 'request failed'));
  const ref = extractApiErrorRef(payload);
  return ref ? `${base} (ref: ${ref})` : base;
}
