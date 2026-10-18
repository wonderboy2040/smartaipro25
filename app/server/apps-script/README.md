# Google Sheets Portfolio Sync — setup

The dashboard syncs your India / US / Crypto portfolio to a Google Sheet via a
small Google Apps Script web app. If holdings were **not** syncing, it was
because the old client code sent the sync as a non-simple CORS request
(`Content-Type: application/json` + `X-Auth-Token` header), which makes the
browser fire a preflight `OPTIONS` request that Google Apps Script cannot
answer — so the POST never reached the script.

The client now sends a CORS **simple** request (`Content-Type: text/plain`, auth
token inside the body), so the sync reaches the script. Deploy `Code.gs` once:

## Steps

1. Create / open a Google Sheet.
2. `Extensions → Apps Script`.
3. Replace the default `Code.gs` with `server/apps-script/Code.gs` from this repo.
4. (Optional) Change `AUTH_TOKEN` — it must match the app's `VITE_API_TOKEN`
   (defaults to `WEALTH_AI_SYNC`).
5. `Deploy → New deployment → Web app`:
   - **Execute as:** Me
   - **Who has access:** Anyone
6. Copy the `…/exec` URL.
7. Set it as the app's sync URL:
   - Frontend build env: `VITE_API_URL=<exec-url>`
   - or the Node server env: `API_URL=<exec-url>` (served via `/api/config`).
8. Redeploy / rebuild. The portfolio now writes to the `WealthAISync` tab and
   loads back on startup.

## Endpoints (handled by `Code.gs`)
| action     | method | purpose                              |
|------------|--------|--------------------------------------|
| `update`   | POST   | save portfolio + usdInr              |
| `load`     | GET    | return saved portfolio               |
| `saveKey`  | POST   | save Groq API key                    |
| `loadKey`  | GET    | return saved Groq API key            |

A GET `?action=update&data=<json>` fallback is also supported for the
fire-and-forget `no-cors` path.
