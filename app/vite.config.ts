import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, writeFileSync } from 'node:fs';

// v20.7.3 FIX (service-worker cache bloat): public/sw.js shipped a frozen
// CACHE_VERSION ('smartai-pro-v20') across every deploy — content-hashed
// chunks accumulated in CacheStorage forever (install/activate never re-ran
// because the SW bytes never changed). This build hook stamps a unique
// per-build suffix into dist/sw.js, so each deploy opens a FRESH cache and
// the SW's activate-eviction deletes the previous one.
const SW_BUILD_STAMP = `b${Date.now().toString(36)}`;
function stampSwVersion() {
  return {
    name: 'stamp-sw-version',
    apply: 'build' as const,
    enforce: 'post' as const,
    closeBundle() {
      try {
        const sw = 'dist/sw.js';
        const src = readFileSync(sw, 'utf8');
        // v21.1.1 [audit D8]: regex-based match — literal string pe public/sw.js
        // me const rename/reformat ho jaye to stamp silently no-op ho jata tha.
        const stamped = src.replace(
          /const CACHE_VERSION = 'smartai-pro-v20[^']*';/,
          `const CACHE_VERSION = 'smartai-pro-v20-${SW_BUILD_STAMP}';`,
        );
        if (stamped !== src) writeFileSync(sw, stamped);
      } catch { /* best-effort — dev/preview unaffected */ }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), stampSwVersion()],
  esbuild: {
    ...(process.env.NODE_ENV === 'production' ? { drop: ['console', 'debugger'] } : {}),
    legalComments: 'none',
  },
  build: {
    target: 'es2022',
    minify: 'esbuild',
    cssMinify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: true,
    // v20.7.12 [L-8]: deskShared (~327KB) intentionally large — shared desk
    // primitives; re-audit with `node scripts/orphan-files.mjs` on changes.
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // React core — cached long-term
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
          // Lucide icons
          if (id.includes('lucide-react')) {
            return 'vendor-icons';
          }
          // v20.7.11 DEAD-CODE PURGE: removed manualChunks rules for modules
          // that no longer exist — motion (Toast is CSS-animated now),
          // lightweight-charts (unused dep, removed), utils/telegram
          // (deleted — 4 live helpers moved to utils/marketClock), and the
          // v18 portfolio analytics family (portfolioAnalytics, riskEngine,
          // dipEngine, wealthEngine, tvWebsocket, smartMoney — all gone
          // with the portfolio feature in v20.0).
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'lucide-react'],
  },
  server: {
    hmr: { overlay: true },
    warmup: {
      clientFiles: ['./src/App.tsx', './src/main.tsx'],
    },
    proxy: {
      // /api/* → Node server (port 8080). Includes /api/ml/* for ML engine.
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    // v18.1 FIX: `vite preview` previously served ONLY static assets — every
    // /api call 404'd, so "build && preview" could never be used as a cheap
    // prod-parity smoke test. Proxy /api exactly like the dev server does.
    proxy: {
      '/api': {
        target: process.env.PREVIEW_API_TARGET || 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});