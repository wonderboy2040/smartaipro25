# SmartAI Pro

Three-desk AI trading terminal: **Crypto (CoinDCX)**, **India Intraday (NSE)**, and **Portfolio** — with dual-timeframe MTF signal boards, paper trading, live-position monitoring, AI committee/ensemble scoring, Telegram alerts, and a local Ollama intelligence layer.

> Current app version: see `app/package.json` (`check:version` keeps `package.json`, `package-lock.json`, and the build stamp in sync).

---

## Quick start (Windows)

1. Extract the project (no installer/`.exe` required).
2. Double-click **`app\Start-SmartAI-Watchdog.bat`**.
3. Open the URL printed in the console (default `http://localhost:5000`).

The watchdog serves the pre-built `app/dist/` immediately, then rebuilds when the source changes. Full setup, API keys, and troubleshooting are in **[`RUN-FIRST.md`](./RUN-FIRST.md)**.

### Manual start (development)

```bash
cd app
npm install
npm run dev          # Vite dev server (frontend)
npm start            # Express API server (http://localhost:5000)
```

Production-style run after a build:

```bash
cd app
npm run build        # vite build + postbuild stamp
npm start
```

---

## Deploy (Vercel frontend + Node backend)

The UI can be hosted on **Vercel**; the Express API must run on a Node host
(Render / Railway / VPS) because it needs WebSockets, SSE, cron jobs, child
processes, and persistent runtime state.

Vercel build fix (repo already contains the config):

- **Root Directory = repository root** → root `vercel.json` installs/builds
  `app/` and publishes `app/dist/`.
- **Root Directory = `app`** → `app/vercel.json` publishes `dist/`.
- Framework preset: **Other** (the config sets `framework: null`).
- Clear any **Build Command / Output Directory** overrides saved in the Vercel
  dashboard — dashboard values win over `vercel.json`.
- Do **not** change the output directory to `dist` when the root is the repo
  root — that is the most common "No Output Directory named dist" failure.
- For a custom domain (anything other than `*.vercel.app`), set
  `VITE_API_PROXY=https://<your-backend-host>` in Vercel → Project Settings →
  Environment Variables, then redeploy. Without it the frontend uses
  same-origin `/api` and the backend will not be found.
- `*.vercel.app` previews default to `https://smartai1.onrender.com`
  (`app/src/utils/api.ts`). Change that default there if your backend lives
  elsewhere.
- On the **Node backend**, add every frontend origin to
  `ALLOWED_ORIGINS` (comma-separated, e.g.
  `https://smartaipro25.vercel.app,https://your-custom-domain`), otherwise
  fail-closed CORS blocks the browser even though `/api/ping` works from curl.

Vercel is static-only for this app: API/SSE/WS routes intentionally stay on the
Node backend. A full-backend Vercel deployment is not supported.

---

## Project layout

```
smartaipro25/
├─ app/
│  ├─ src/                 React + TypeScript frontend (three desks, panels, hooks)
│  ├─ server/              Express API, signal engines, execution, MCP mesh, Telegram
│  ├─ test/                Vitest suite (server + frontend contracts)
│  ├─ scripts/             Build/version/route checks, calibration, backups
│  ├─ dist/                Tracked production build (served by the watchdog)
│  ├─ docs/                CHANGES, audits, and operational notes
│  └─ telegram-bot/        Standalone Telegram bot package
├─ deploy/                 Deployment helpers
└─ RUN-FIRST.md            Step-by-step Windows setup + release notes
```

Runtime state lives under `app/server/data/` and `app/data/` (ignored by git). Do **not** delete these while positions/trades are open — they contain signal ledgers, paper trades, journals, and bot state.

---

## Quality gates

Run from `app/`:

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint (server + src)
npm run check:version # version consistency
npm test              # vitest (sequential; can take 10+ minutes)
npm run build         # production bundle
npm run check:routes  # frontend fetch calls vs backend routes
npm run audit:all     # npm audit for app + telegram-bot
```

Or the full chain: `npm run check`.

---

## Notes

- Trade-signal generation and execution engines are sensitive; changes should stay additive and be verified with the relevant tests.
- `app/dist/` is intentionally committed so the watchdog can serve immediately after extraction. Rebuild before committing so `dist` matches `src`.
- API keys and secrets belong in `app/.env` (see `app/.env.example`); never commit real credentials.
- Historical changes and known environment-dependent test failures are documented in `app/docs/CHANGES.md`.
