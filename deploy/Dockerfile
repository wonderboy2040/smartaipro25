# ============================================================
# deploy/Dockerfile — Jev Bot Lab v20.8.1 (plan §12 Phase 8)
# ------------------------------------------------------------
# v20.8.1 FIX (H2): MULTI-STAGE build — the old single-stage image
# never built the frontend (npm ci --omit=dev, no dist/), so a fresh
# clone + compose up served an API-only container: every page 404'd.
# builder stage compiles the SPA; runtime copies dist/ in.
# Node 20 slim, production deps only, TZ=Asia/Kolkata (NSE desk
# canonical time), healthcheck on /api/ping. State + cache are
# VOLUMES (never baked into the image). Secrets come from the env
# file (scp'd, mode 600) — never from the image.
# ============================================================

# ---------- stage 1: build the frontend ----------
FROM node:20-slim AS builder
WORKDIR /app
COPY app/package*.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

# ---------- stage 2: runtime ----------
FROM node:20-slim
WORKDIR /app

# app lives in ./app relative to repo root (docker-compose build
# context = repo root). Copy manifests first for layer caching.
COPY app/package*.json ./
RUN npm ci --omit=dev

# v20.8.2 FIX (H3): the forked Telegram poller (app/telegram-bot/bot.mjs)
# imports node-telegram-bot-api — that dep lives ONLY in
# telegram-bot/package.json, so a TG_TOKEN deploy crashed the child with
# MODULE_NOT_FOUND and restart: always turned it into a loop.
# v20.8.4 FIX (H1 — build unconditionally broken): COPY resolves against
# the CONTEXT ROOT (docker-compose sets context: .. = repo root), but the
# bot lives at app/telegram-bot/ — a bare `COPY telegram-bot/` could never
# match, so EVERY `compose up --build` died at stage 2 with "no source
# files were specified". The whole multi-stage path was dead code.
COPY app/telegram-bot/package*.json ./telegram-bot/
RUN npm ci --omit=dev --prefix telegram-bot

COPY app/ ./
COPY app/telegram-bot/ ./telegram-bot/
# v20.8.1: the built SPA from stage 1 (server/index.js serves dist/)
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV TZ=Asia/Kolkata
# Bot Lab: PAPER by default — LIVE requires an explicit, conscious
# override at deploy time (ground rule #5: paper pehle, live baad me).
ENV BOTS_MODE=PAPER
# v20.8.2 FIX (H3): state on the PERSISTED path by default — bare
# `docker run` (no compose env) used to fall back to /app/app/data/bots
# on the ephemeral layer, so kill switches + accounts vanished on
# container replacement. Matches the compose volume below.
ENV BOT_STATE_DIR=/app/server/data/bots
RUN mkdir -p /app/server/data/bots

# v20.8.4 FIX (H3 — root container): the node image used to run as root
# (contrast: app/ml-service/Dockerfile already runs as nobody). Node's
# built-in `node` user (uid 1000) owns the writable state dir; everything
# else stays root-owned read-only for it.
RUN chown -R node:node /app/server/data
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 8080
# v21.3.0 (Issue-1): V8 heap budget BEFORE the cgroup kill — Node's default
# (~256MB usable heap inside a 512MB container) GC-thrashes right before the
# OOM-killer fires; an explicit 384MB old-space lets GC win instead.
CMD ["node", "--max-old-space-size=384", "server/index.js"]
