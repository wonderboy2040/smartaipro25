// ============================================================
// server/lib/asyncGuard.js — v21.3.0 (Issue-1: repeated server down)
// ------------------------------------------------------------
// THE BUG: Express 4 does NOT route a rejected async handler
// promise to the error middleware — `async (req,res) => { throw }`
// becomes an unhandledRejection (selfHeal logs it, the PROCESS
// survives) but the CLIENT SOCKET HANGS until timeout. The user
// sees "request pending / site atki hui" — a per-request "down".
//
// THE FIX: `withAsyncRouteGuard(app)` returns a Proxy that wraps
// ONLY async route handlers (fn.constructor.name === 'AsyncFunction',
// arity < 4 — error middleware is 4-arg and is never touched) in a
// `.catch(next)` shim. Sync handlers, router objects, middleware
// factories (express.json()) and settings getters pass through
// UNCHANGED — zero behavior change for everything that already
// worked, async throws become honest 500s.
// ============================================================

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use'];

function _wrapHandler(h, onError) {
  if (typeof h !== 'function') return h;          // router objects, paths, options
  const isAsync = h.constructor && h.constructor.name === 'AsyncFunction';
  if (!isAsync) return h;                          // sync middleware/handler untouched
  if (h.length >= 4) return h;                     // 4-arg = error middleware — never wrap
  return function __asyncGuarded(req, res, next) {
    try {
      Promise.resolve(h(req, res, next)).catch((err) => {
        try { if (typeof onError === 'function') onError(err); } catch { /* log best-effort */ }
        if (typeof next === 'function') {
          try { next(err); } catch { /* next after headers sent */ }
        } else {
          // no next (shouldn't happen in a route) — last-resort honest 500
          try { if (!res.headersSent) res.status(500).json({ ok: false, error: 'async handler failed' }); } catch { /* socket gone */ }
        }
      });
    } catch (err) {
      if (typeof next === 'function') next(err);
    }
  };
}

/**
 * Wrap an Express app (or Router) so every ASYNC handler registered
 * through the returned proxy forwards rejections to next(err).
 * The original app object is untouched (identity preserved for the
 * pieces that keep using it directly).
 */
export function withAsyncRouteGuard(app, opts = {}) {
  if (!app || typeof app !== 'object' && typeof app !== 'function') return app;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  return new Proxy(app, {
    get(target, prop) {
      if (typeof prop === 'string' && HTTP_METHODS.includes(prop)) {
        return (...args) => target[prop](...args.map((a) => _wrapHandler(a, onError)));
      }
      const v = Reflect.get(target, prop);
      if (typeof v === 'function') return v.bind(target);
      return v;
    },
  });
}

/** Test hook — the wrap rule, pure. */
export const __testWrap = _wrapHandler;
