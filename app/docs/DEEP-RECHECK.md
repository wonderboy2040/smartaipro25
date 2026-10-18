# Deep Recheck Report — SmartAI Pro v20.4.2

## Verification (all green)
| Check | Result |
|---|---|
| `npm install` (app + telegram-bot) | OK |
| `tsc --noEmit` | 0 errors |
| `npm run check:routes` | PASS |
| `npm run build` (Vite) | OK |
| `node --check` on every .js/.mjs (server, telegram-bot, scripts, public) | 0 syntax errors |
| `vitest run` | 153 files / 2737 tests passed (+1 new regression test) |
| Python `compileall` (ml-service) | OK |
| Server boot smoke test (`/api/ping`, `/`, login flow) | OK |
| Secret scan (keys / tokens / private keys) | none (only dummy test token) |

## Issues found & fixed
1. **False "HARD KILL" alarm on every restart** (`server/ai/selfHeal.js`)
   `initSelfHeal()` wrote this run's `boot` record *before* `reportLastExitOnBoot()` read the journal,
   so the last record was always its own boot → always reported HARD KILL (even after clean shutdown / first run).
   Fix: snapshot the journal tail before writing the boot record. Regression test added in
   `test/selfHealGuard.test.ts` (verified it fails without the fix).
2. **Session cookie always `Secure`** (`server/index.js`, login + logout)
   On plain HTTP (LAN IP, Safari, non-localhost) the browser silently dropped the cookie.
   Fix: HTTPS (incl. `x-forwarded-proto: https`) → `SameSite=None; Secure`; HTTP → `SameSite=Lax`.
   Cross-origin HTTPS deployments (Vercel → Render) behave exactly as before. Verified live with curl.
3. **Mojibake (double-encoded UTF-8)** in `server/index.js` — 41 places incl. user-visible console warnings
   and the multi-engine consensus message (`â€”`, `ðŸ¤`, `â”â”`, `â˜ï¸`). Repaired to proper — → 🤝 ━ ☁️.
4. **Duplicate folder** `scripts/fixtures/fixtures/` (identical copies, unreferenced) removed.

## Notes / recommendations (not changed — config or design choices)
- `APP_PIN` should be ≥ 8 chars; `ALLOWED_ORIGINS` must be set for cross-origin deployments (CORS is fail-closed).
- `/api/health` requires auth (401 without login) — use `/api/ping` for unauthenticated uptime checks.
- `index.html` redirects any `*.vercel.app` host to `https://smartai1.onrender.com` (hard-coded) — change if your backend URL differs.
- Many mesh-agent / AI-provider keys are unset by default (see `.env.example`); those features abstain honestly.

---

# Deep Recheck Report — v20.7.1

## Verification
| Check | Result |
|---|---|
| `npm install` (app + telegram-bot) | OK |
| `tsc --noEmit` | 0 errors |
| `npm run check:routes` | **was FAIL → now PASS** |
| `npm run build` (Vite) | OK |
| `node --check` on all .js/.mjs | 0 syntax errors |
| Server boot smoke test (`/api/ping`, `/`) | OK |
| Secret scan | none (only dummy test token) |

## Issues found & fixed
1. **Orphan `SelfImprovementPanel.tsx` calling removed routes** (`/api/ai/self/status|proposals|lessons`).
   v20.6.3 removed the backend routes and claimed the panel file was "GONE" (a test asserts it), but the file was still in the repo
   and made `check:routes` FAIL. File deleted. Stale comments in `server/index.js` that said the routes "stay mounted" corrected.
2. **Leader lease was a no-op** (`server/exec/reconciler.js`): `_iAmLeader` compared a value with itself (always `true`), so
   a second node (e.g. Render copy) could also place orders → duplicate orders. Now: `SMARTAI_EXEC_LEADER` (default `laptop`)
   vs `SMARTAI_EXEC_NODE`; unset NODE = single-node setup = leader (backward compatible). Tests updated + added.
3. **`PositionManager` rounded exit quantities to 2 decimals** (`r2(qty × pct)`): for small BTC/ETH sizes (qtyStep 0.0001)
   the T1/T2 reduce qty could round to 0 and silently skip the exit. Now floors to the 0.0001 step.
4. **Tiered reversal "50% reduce" used the ORIGINAL qty**, not what is still open — after T1+T2 trims it could ask to reduce
   more than the remaining position. Now uses the live position qty.
5. **`computeSizing` capped branches** (`server/exec/sizing.js`):
   - `guards.liqGuard` compared percent with a fraction (always `true`) → units fixed.
   - margin-capped / Σ-margin-reduced paths returned `verdict: 'OK'` even when the reduced qty was below `instrument.minQty`
     → now returns `SKIP_MIN_QTY`.
   - qty step floor produced float noise (`0.30000000000000004`) → trimmed to the step's decimals.
6. `package-lock.json` version header out of sync with `package.json` (20.6.3 vs 20.7.0) → synced.
7. `.env.example` now documents `EXEC_MODE`, `SMARTAI_EXEC_LEADER`, `SMARTAI_EXEC_NODE`.

New regression tests: `test/execFixes.test.ts`, extra leader-lease cases in `test/reconciler.test.ts`.

## Notes (not changed — config / design choices)
- `index.html` redirects any `*.vercel.app` host to `https://smartai1.onrender.com` (hard-coded) — change if your backend URL differs.
- `ALLOWED_ORIGINS` must be set for cross-origin deployments (CORS is fail-closed). `/api/health` needs auth; use `/api/ping` for uptime checks.
- Mesh-agent / AI-provider keys are unset by default (see `.env.example`); those features abstain honestly.
- Run `EXEC_MODE=paper` until the reconciler/position manager have been validated against the real exchange.
