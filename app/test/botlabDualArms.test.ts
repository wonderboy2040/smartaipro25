// ============================================================
// test/botlabDualArms.test.ts — v21.14.0 (Laya removal)
// ------------------------------------------------------------
// BotRunner availability-resolve + routes contract:
//   • arm=jev + instance absent → arm_fallback event + gated
//   • v21.14 legacy arms: laya → jev (agar jev hai) warna gated;
//     consensus → jev warna gated (event me honest reason)
//   • arm=auto + jev absent → gated
//   • status().ai shape {jev} + purana `jev` field compat
//   • settle events me `arm` stamp (position meta se)
//   • POST /api/bots/arm: valid arms, unavailable → 409, unknown → 400
//     (legacy laya/consensus arms ab 400 unknown-arm)
//   • GET /api/bots/ai/health shape
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotRunner } from '../server/bots/botRunner.js';
import { saveBotState, readEvents } from '../server/bots/botState.js';
import { createJev } from '../server/bots/jevEngine.js';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualarm-')); });

const ENV = { BOTS_MODE: 'PAPER', BOTS_ENABLED: 'orb_crypto_utc' };
const mkJev = () => createJev({ apiKey: 'k', cachePath: path.join(dir, 'jev_cache.jsonl') });

describe('v21.14 BotRunner — availability-resolve (hamesha event-file me record)', () => {
  it('arm=jev + no jev instance → arm_fallback {from:jev,to:gated} + gated decider chalta hai', async () => {
    saveBotState(dir, 'orb_crypto_utc', { arm: 'jev' });
    const r = new BotRunner({ stateDir: dir, env: { ...ENV }, ai: { jev: null } });
    await r.tick('orb_crypto_utc');
    const evs = readEvents(dir, 'orb_crypto_utc', 50);
    const fb = evs.find((e) => e.kind === 'arm_fallback');
    expect(fb).toBeTruthy();
    expect(fb.from).toBe('jev');
    expect(fb.to).toBe('gated');
    expect(fb.reason).toBe('no_jev_instance');
  });

  it('v21.14: legacy arm=laya + jev present → mapped to jev (arm_fallback event, honest reason)', async () => {
    saveBotState(dir, 'orb_crypto_utc', { arm: 'laya' });
    const r = new BotRunner({ stateDir: dir, env: { ...ENV }, ai: { jev: mkJev() } });
    await r.tick('orb_crypto_utc');
    const fb = readEvents(dir, 'orb_crypto_utc', 50).find((e) => e.kind === 'arm_fallback');
    expect(fb).toBeTruthy();
    expect(fb.from).toBe('laya');
    expect(fb.to).toBe('jev');
    expect(fb.reason).toBe('laya_provider_removed_v21_14');
  });

  it('v21.14: legacy arm=laya + jev bhi absent → gated (reason honest)', async () => {
    saveBotState(dir, 'orb_crypto_utc', { arm: 'laya' });
    const r = new BotRunner({ stateDir: dir, env: { ...ENV }, ai: { jev: null } });
    await r.tick('orb_crypto_utc');
    const fb = readEvents(dir, 'orb_crypto_utc', 50).find((e) => e.kind === 'arm_fallback');
    expect(fb).toBeTruthy();
    expect(fb.from).toBe('laya');
    expect(fb.to).toBe('gated');
    expect(fb.reason).toBe('laya_provider_removed_no_jev');
  });

  it('v21.14: legacy arm=consensus + jev present → mapped to jev (consensus_retired)', async () => {
    saveBotState(dir, 'orb_crypto_utc', { arm: 'consensus' });
    const r = new BotRunner({ stateDir: dir, env: { ...ENV }, ai: { jev: mkJev() } });
    await r.tick('orb_crypto_utc');
    const fb = readEvents(dir, 'orb_crypto_utc', 50).find((e) => e.kind === 'arm_fallback');
    expect(fb).toBeTruthy();
    expect(fb.from).toBe('consensus');
    expect(fb.to).toBe('jev');
    expect(fb.reason).toBe('consensus_retired_single_provider');
  });

  it('v21.14: legacy arm=consensus + jev absent → gated (no_ai_providers)', async () => {
    saveBotState(dir, 'orb_crypto_utc', { arm: 'consensus' });
    const r = new BotRunner({ stateDir: dir, env: { ...ENV }, ai: { jev: null } });
    await r.tick('orb_crypto_utc');
    const fb = readEvents(dir, 'orb_crypto_utc', 50).find((e) => e.kind === 'arm_fallback');
    expect(fb).toBeTruthy();
    expect(fb.from).toBe('consensus');
    expect(fb.to).toBe('gated');
    expect(fb.reason).toBe('no_ai_providers');
  });

  it('arm=auto + jev absent → gated fallback', async () => {
    saveBotState(dir, 'orb_crypto_utc', { arm: 'auto' });
    const r = new BotRunner({ stateDir: dir, env: { ...ENV }, ai: { jev: null } });
    await r.tick('orb_crypto_utc');
    const fb = readEvents(dir, 'orb_crypto_utc', 50).find((e) => e.kind === 'arm_fallback');
    expect(fb.from).toBe('auto');
    expect(fb.to).toBe('gated');
    expect(fb.reason).toBe('no_ai_providers');
  });

  it('status().ai = {jev} per-provider stats; purana `jev` field back-compat; laya key absent', () => {
    const r = new BotRunner({ stateDir: dir, env: { ...ENV }, ai: { jev: mkJev() } });
    const st = r.status();
    expect(st.ai).toBeTruthy();
    expect(st.ai.jev.name).toBe('jev');
    expect(st.ai.jev.hasKey).toBe(true);
    expect('laya' in st.ai).toBe(false);
    // legacy compat field (UI purane consumers)
    expect(st.jev.name).toBe('jev');
    // aiMode defaults surface (v21.14: primary always jev)
    expect(st.aiMode).toEqual({ primary: 'jev', shadow: 'off', onDown: 'wait' });
  });

  it('purana `jev` ctor param ab bhi kaam karta hai (ai.jev pe map)', () => {
    const j = mkJev();
    const r = new BotRunner({ stateDir: dir, env: { ...ENV }, jev: j });
    expect(r.jev).toBe(j);
    expect(r.ai.jev).toBe(j);
    expect(r.status().ai.jev.hasKey).toBe(true);
  });
});

describe('v21.14 routes — arm route + AI health (REAL HTTP)', () => {
  let server: Server | null = null;
  let base = '';
  afterEach(async () => {
    if (server) { await new Promise<void>((res) => server!.close(() => res())); server = null; }
  });

  async function boot(env: Record<string, string>) {
    // getBotRunner ek MODULE-LEVEL SINGLETON hai (production: boot pe ek
    // hi baar banta hai, env usi waqt freeze hota hai). Har test case
    // fresh registry chahiye isliye module reset + dynamic import —
    // pinAuth.test.ts ka hi pattern.
    vi.resetModules();
    const { registerBotRoutes } = await import('../server/bots/routes.js');
    const app = express();
    app.use(express.json());
    registerBotRoutes(app, { env: { ...ENV, ...env }, stateDir: dir, candleProvider: null });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', () => r()));
    base = `http://127.0.0.1:${(server!.address() as any).port}`;
  }

  it('unknown arm → 400; valid arm (rules/gated) → 200 + persisted', async () => {
    await boot({});
    const bad = await fetch(`${base}/api/bots/arm/orb_crypto_utc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arm: 'psychic' }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/api/bots/arm/orb_crypto_utc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arm: 'rules' }) });
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.arm).toBe('rules');
  });

  it('arm=jev without provider → 409 provider_unavailable {provider:jev} + hint', async () => {
    await boot({});
    const r = await fetch(`${base}/api/bots/arm/orb_crypto_utc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arm: 'jev' }) });
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toBe('provider_unavailable');
    expect(j.provider).toBe('jev');
    expect(String(j.hint)).toContain('TYPESAFE_API_KEY');
  });

  it('v21.14: legacy laya/consensus arms → 400 unknown-arm (ARMS_ALLOWED me nahi)', async () => {
    await boot({ TYPESAFE_API_KEY: 'k' });
    const r1 = await fetch(`${base}/api/bots/arm/orb_crypto_utc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arm: 'laya' }) });
    expect(r1.status).toBe(400);
    const r2 = await fetch(`${base}/api/bots/arm/orb_crypto_utc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arm: 'consensus' }) });
    expect(r2.status).toBe(400);
    // error message me allowed arms listed
    const j = await r1.json();
    expect(String(j.error)).toContain('rules|gated|jev|auto');
  });

  it('arm=auto with jev key → 200; without → 409', async () => {
    await boot({});
    const r1 = await fetch(`${base}/api/bots/arm/orb_crypto_utc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arm: 'auto' }) });
    expect(r1.status).toBe(409);

    await boot({ TYPESAFE_API_KEY: 'k' });
    const r2 = await fetch(`${base}/api/bots/arm/orb_crypto_utc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arm: 'auto' }) });
    expect(r2.status).toBe(200);
    expect((await r2.json()).arm).toBe('auto');
  });

  it('v21.14: legacy laya-status endpoint gone → 404', async () => {
    await boot({ TYPESAFE_API_KEY: 'k' });
    const r = await fetch(`${base}/api/bots/ai/laya-status`);
    expect(r.status).toBe(404);
    const r2 = await fetch(`${base}/api/bots/ai/laya-relink`, { method: 'POST' });
    expect(r2.status).toBe(404);
  });

  it('GET /api/bots/ai/health — provider block (configured flags honest)', async () => {
    await boot({ TYPESAFE_API_KEY: 'k' });
    const r = await fetch(`${base}/api/bots/ai/health`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.jev.configured).toBe(true);
    expect(j.jev.reachable).toBe(true);
    expect(j.jev.breakerOpen).toBe(false);
    expect('laya' in j).toBe(false);
    expect(typeof j.at).toBe('string');
  });

  it('status endpoint me ai block (SSE/status consumers)', async () => {
    await boot({ TYPESAFE_API_KEY: 'k' });
    const r = await fetch(`${base}/api/bots/status`);
    const j = await r.json();
    expect(j.ai.jev.name).toBe('jev');
    expect('laya' in j.ai).toBe(false);
    expect(j.aiMode.primary).toBe('jev');
    expect(j.layaAutoLink).toBeUndefined();
  });
});
