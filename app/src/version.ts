// ============================================================
// src/version.ts — v20.3 SINGLE-SOURCE version marker
// ------------------------------------------------------------
// v20.2 zip shipped a "v20.0" header badge (two releases stale) because
// the badge + console banner were hardcoded strings nobody bumps. Every
// user-visible version claim now derives from HERE. The release gate
// (v20.8.2: tsc --noEmit + vitest + vite build — the old comment named
// a build_v203_full.sh script that no longer exists) requires this
// stamp and the package.json version to agree before a zip ships.
// ============================================================
export const APP_VERSION = '21.27.1';
export const APP_TITLE = `SmartAI Pro v${APP_VERSION} — THREE-DESK TERMINAL (India Intraday + CoinDCX + JEV BOT LAB) — AI PIPELINE (rules | gated | jev | auto — Jev cloud, probabilities-gated no-flip filter — take-normalized; v21.14 Laya local provider removed), USDT-denominated crypto candle chain (Binance/Bybit primary, CoinDCX-INR scaled last leg, store-merged 2200-bar warmup — the 300-bar feed left crypto ATR null forever), honest engine (gap-through-stop, maxHoldBars + 15:10 IST square-off now HONORED LIVE via settle time-exits, next-open fills), hard botRisk layer (fee gate fail-closed, daily-loss kill, per-currency totals, aligned staleness window, per-tick open-cap refresh), attempt persistence for ALL strategies (orb_in sessionKey fixed), restart-safe paper positions (snapshot + rehydrate), append-only candle store + events mtime cache, decision stream with reconnect dedupe + honest ORDERED/FAILED verdicts, ALWAYS-LATEST launcher (supervisor ensureFrontend: dist/.build-version stamp vs package.json — mismatch = auto npm install + rebuild, stale v20.7.5-serve khatam; /api/ping v + UI STALE-BUILD banner), multi-stage Docker deploy with telegram-bot deps + APP_PIN template — paper pehle, edge nahi dikha to bot band`;
