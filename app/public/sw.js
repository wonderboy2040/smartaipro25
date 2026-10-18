/* ============================================================
 * SmartAI Pro v21 — Service Worker (LEAN SHELL)
 * ------------------------------------------------------------
 * v20.0 REWRITE: the portfolio background-sync engine (15-min
 * price fetch, widget data, P&L badge, price notifications) is
 * REMOVED with the portfolio feature. What remains is the
 * minimum a localhost trading terminal needs:
 *   1. App-shell precache (offline boot)
 *   2. Navigation: network-first, cached shell fallback
 *   3. Hashed static assets: stale-while-revalidate
 *   4. /api/* and /api/stream: NEVER intercepted (network only;
 *      SSE pass-through, private data never touches CacheStorage)
 * ACTIVATE evicts EVERY cache older than the current version —
 * including any private-API leftovers from pre-v12.7 denylist
 * days.
 * v20.7.3 FIX (cache bloat): the version string was frozen at
 * 'v20' across all deploys — new content-hashed chunks were
 * cached but the OLD ones were never evicted (the SW itself was
 * byte-identical, so install/activate never re-ran). The build
 * now stamps a unique suffix into dist/sw.js (see
 * vite.config.ts → stamp-sw-version), so every deploy gets a
 * fresh cache and the activate-eviction below cleans the orphans.
 * ============================================================ */

const CACHE_VERSION = 'smartai-pro-v20';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  // ALL API traffic (incl. SSE /api/stream) — network only, never cached
  if (url.pathname.startsWith('/api/')) return;

  // App navigation → network-first, fall back to cached shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // v20.9.1 [M]: sirf OK responses hi shell cache me — pehle 502/504
          // proxy error pages bhi /index.html ke naam pe cache ho jati
          // thi aur agli offline fallback usi error page ko serve karta
          // tha (successful navigation tak).
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put('/index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || new Response('Offline', { status: 503 })))
    );
    return;
  }

  // Static assets → stale-while-revalidate
  // v20.7.3 FIX: offline + uncached (fresh post-deploy chunk) used to
  // resolve respondWith(undefined) → hard TypeError. Return a proper
  // network-error Response instead.
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    })
  );
});
