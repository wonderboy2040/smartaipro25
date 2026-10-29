# SmartAI Pro Telegram Bot

Zero-dependency control surface for SmartAI Pro. The bot owns **no** market,
portfolio or signal state: every number it shows comes from the local site API
(`http://127.0.0.1:8080` by default), which remains the single source of truth.

`Start-SmartAI-Watchdog.bat` → `server/index.js` → forks `telegram-bot/bot.mjs`
with the server environment (`BOT_ONLY=true`). No separate install step and no
third-party npm packages are required.

## Safety model

- **Owner only.** `TG_CHAT_ID` is an allowlist. Unknown chats are ignored (one
  warning at most every 10 minutes).
- **Dangerous actions need an inline tap.** `/auto on` and switching execution
  to LIVE only create a confirmation prompt; nothing executes until the owner
  taps **Confirm**. Prompts expire after `BOT_CONFIRM_TTL_MS` (90s default).
  `/auto off` and switching to PAPER execute immediately because they reduce
  risk.
- **No secret commands.** There is no `/setkey`, `/debug_env` or equivalent.
  Tokens, API keys, APP PIN and raw chat ids are never printed by the bot.
- **No direct exchange access.** The bot never talks to CoinDCX/Dhan and never
  stores credentials. It only calls the authenticated site API.
- **Signal/order honesty.** Board cards show the signal side and the direction
  certificate's `orderSide`. A mismatch is visibly flagged (`SIDE MISMATCH`)
  instead of being hidden.
- **Risk sizing is reported, never silently changed.** Wallet, risk/trade,
  deployment %, leverage and daily quota are displayed exactly as the server
  returns them (`riskCaps`, `effectiveWalletINR`).

## Configuration

The bot reads environment variables from (in order, first value wins):

1. real process environment (normal watchdog launch),
2. `telegram-bot/.env` (optional overrides),
3. `app/.env` (the server's existing config).

Minimum values (already present in `app/.env` for a working install):

| Variable | Required | Meaning |
| --- | --- | --- |
| `TG_TOKEN` | yes | BotFather token |
| `TG_CHAT_ID` | yes | Owner user id (comma-separated for multiple owners) |
| `API_TOKEN` | yes | Same server-only service token as the site |
| `PORT` | no | Local server port, default `8080` |

Optional overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_API_BASE_URL` | `http://127.0.0.1:$PORT` | Site API base URL |
| `BOT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `BOT_STATE_FILE` | `.state.json` | Durable poll offset |
| `BOT_LOCK_FILE` | `.bot.lock` | Single-instance lock |
| `BOT_POLL_TIMEOUT_SEC` | `10` | Long-poll timeout (5-50) |
| `BOT_CONFIRM_TTL_MS` | `90000` | Confirmation lifetime (15s–5min) |
| `BOT_BOARD_TIMEOUT_MS` | `90000` | MTF board request timeout |
| `BOT_AGENT_TIMEOUT_MS` | `120000` | AI desk request timeout |

Copy `.env.example` to `.env` only if you want bot-specific overrides. Do not
commit `.env`.

## Commands

| Command | What it does |
| --- | --- |
| `/status` | Server, auto engine, journal/paper P&L, push health |
| `/signals [crypto\|india\|metals\|futures\|global]` | Cached MTF dual board |
| `/scan [market]` | Fresh full scan (20–90s, 20s cooldown) |
| `/positions` | Open journal/live + paper positions |
| `/pnl [today\|week]` | Measured P&L, weekly review for `week` |
| `/auto [status\|on\|off\|paper\|live]` | Auto-trade control; arming asks first |
| `/alerts` | Instant-push pipeline + 24h delivery health |
| `/weekly` | Weekly performance review |
| `/health` | `/health` + `/api/health` deep status |
| `/ping`, `/version`, `/id` | Diagnostics |
| `/crypto <q>`, `/india <q>` | Desk AI agents |
| plain text | Default crypto desk; India symbols route to India desk |
| `/reset` | Clear this chat's AI context |
| `/menu`, `/help`, `/cancel` | UI / help / cancel pending confirmation |

## Startup behaviour

- Persists the Telegram update offset in `.state.json`; after a restart it
  resumes without replaying old commands.
- If the bot was offline for more than 5 minutes, pending updates are dropped at
  startup so it never executes a stale queue.
- Clears any registered webhook (polling and webhook cannot coexist), registers
  the command menu with `setMyCommands`, and sends **no** startup spam.
- Single instance only (`.bot.lock`); a second process exits instead of causing
  Telegram 409 storms.
- Handles Telegram `409` (webhook conflict), `429` (`retry_after`) and 5xx with
  bounded backoff. Exits cleanly on `SIGTERM`, `SIGINT` or parent disconnect.

## Development

```powershell
cd app/telegram-bot
npm test          # node:test suite, no network
npm run check     # syntax check + tests
npm start         # run standalone (server must already be running)
```

The real launch path remains:

```powershell
app\Start-SmartAI-Watchdog.bat
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Bot silent, server log says `Bot child: false` | `TG_TOKEN` / `TG_CHAT_ID` in `app/.env` |
| Commands reply `API auth fail (401)` | `API_TOKEN` must match between the bot and server |
| `Server se connect nahi hua` | Is the server on `PORT`/`BOT_API_BASE_URL` running? |
| `Telegram 409 conflict` | Another poller is using the token; stop it. Webhook is cleared automatically |
| `Another bot instance is already running` | Remove `telegram-bot/.bot.lock` only after confirming no bot process is alive |
| Live mode blocked | CoinDCX credentials or kill switch on the site |

## Layout

```
telegram-bot/
  bot.mjs              entry point + long-poll loop
  lib/api.mjs          authenticated site API client (TTL cache)
  lib/commands.mjs     command metadata + handlers
  lib/config.mjs       env/dotenv loading, safe defaults
  lib/format.mjs       all Telegram HTML/plain rendering
  lib/lock.mjs         single-instance lock
  lib/logger.mjs       redacting logger
  lib/router.mjs       owner gate, confirmations, queues, callbacks
  lib/state.mjs        atomic JSON state (poll offset)
  lib/telegram.mjs     Bot API transport, chunking, parse fallback
  lib/util.mjs         formatting, IST time, HTML splitter
  test/                node:test suite
```
