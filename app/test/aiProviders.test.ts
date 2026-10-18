// ============================================================
// test/aiProviders.test.ts — v21.14.0 (Laya removal)
// ------------------------------------------------------------
// Provider registry contract:
//   • buildProviders: TYPESAFE_API_KEY ke hisaab se jev null ya
//     instance; cache path jev_cache.jsonl (v21.14: laya removed —
//     LAYA_* env vars are never read, laya key is never set)
//   • aiModeConfig: AI_SHADOW / AI_CONSENSUS_ON_DOWN
//     (invalid values safe defaults pe girti hain; primary always jev)
//   • providerHealth: instance absent = configured:false; breaker
//     open = reachable:false
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProviders, aiModeConfig, providerHealth } from '../server/bots/aiProviders.js';

let tmpDir = '';
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiprov-'));
});

describe('v21.14 buildProviders — registry rules (Laya removed)', () => {
  it('no keys at all → jev null (honest emptiness), no laya key ever', () => {
    const p = buildProviders({}, { stateDir: tmpDir });
    expect(p.jev).toBeNull();
    expect('laya' in p).toBe(false);
  });

  it('TYPESAFE_API_KEY only → jev instance', () => {
    const p = buildProviders({ TYPESAFE_API_KEY: 'k' }, { stateDir: tmpDir });
    expect(p.jev).toBeTruthy();
    expect(typeof p.jev).toBe('function');
    expect('laya' in p).toBe(false);
  });

  it('v21.14: legacy LAYA_* env vars are IGNORED (provider never built)', () => {
    const p = buildProviders({ LAYA_ENABLED: '1', LAYA_API_KEY: 'lk', LAYA_BASE_URL: 'http://127.0.0.1:8000' }, { stateDir: tmpDir });
    expect(p.jev).toBeNull();
    expect('laya' in p).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'laya_cache.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'laya_autolink.json'))).toBe(false);
  });

  it('cache file is jev_cache.jsonl (provider-wise naming kept)', () => {
    const p = buildProviders({ TYPESAFE_API_KEY: 'k' }, { stateDir: tmpDir });
    expect((p.jev as any).config().cachePath).toBe(path.join(tmpDir, 'jev_cache.jsonl'));
  });

  it('JEV env overrides flow through the registry (JEV_BASE_URL / JEV_MODEL / JEV_THRESHOLD)', () => {
    const p = buildProviders({
      TYPESAFE_API_KEY: 'k',
      JEV_BASE_URL: 'https://jev.example',
      JEV_MODEL: 'jev-v2',
      JEV_THRESHOLD: '0.45',
    }, { stateDir: tmpDir });
    const cfg = (p.jev as any).config();
    expect(cfg.url).toBe('https://jev.example/v1/systemone');
    expect(cfg.model).toBe('jev-v2');
    expect(cfg.threshold).toBe(0.45);
  });
});

describe('v21.14 aiModeConfig — mode flags (safe defaults)', () => {
  it('defaults: primary=jev (always), shadow=off, onDown=wait', () => {
    const c = aiModeConfig({});
    expect(c).toEqual({ primary: 'jev', shadow: 'off', onDown: 'wait' });
  });

  it('v21.14: AI_PRIMARY is always jev (legacy laya value ignored)', () => {
    expect(aiModeConfig({ AI_PRIMARY: 'laya' }).primary).toBe('jev');
    expect(aiModeConfig({ AI_PRIMARY: 'gpt' }).primary).toBe('jev');
  });

  it('AI_SHADOW jev respected; anything else (incl legacy laya) → off', () => {
    expect(aiModeConfig({ AI_SHADOW: 'laya' }).shadow).toBe('off');
    expect(aiModeConfig({ AI_SHADOW: 'jev' }).shadow).toBe('jev');
    expect(aiModeConfig({ AI_SHADOW: 'both' }).shadow).toBe('off');
  });

  it('AI_CONSENSUS_ON_DOWN=single respected; anything else → wait (SAFE default)', () => {
    expect(aiModeConfig({ AI_CONSENSUS_ON_DOWN: 'single' }).onDown).toBe('single');
    expect(aiModeConfig({ AI_CONSENSUS_ON_DOWN: 'yolo' }).onDown).toBe('wait');
  });
});

describe('v21.14 providerHealth — honest per-provider block', () => {
  it('absent provider → configured:false, reachable:false', () => {
    const h = providerHealth({ jev: null });
    expect(h.jev.configured).toBe(false);
    expect(h.jev.reachable).toBe(false);
    expect('laya' in h).toBe(false);
  });

  it('configured provider (breaker closed) → configured+reachable; breaker open → NOT reachable', async () => {
    const { createJev } = await import('../server/bots/jevEngine.js');
    const ok = createJev({ apiKey: 'k', cachePath: path.join(tmpDir, 'ok.jsonl') });
    const h1 = providerHealth({ jev: ok });
    expect(h1.jev.configured).toBe(true);
    expect(h1.jev.reachable).toBe(true);
    expect(h1.jev.breakerOpen).toBe(false);
    expect(h1.jev.rejects).toBe(0);

    // force breaker open via test hook
    const down = createJev({ apiKey: 'k', cachePath: path.join(tmpDir, 'down.jsonl') });
    (down as any).__breakerFail();
    (down as any).__breakerFail();
    (down as any).__breakerFail();
    (down as any).__breakerFail(); // 4 consecutive = default threshold
    const h2 = providerHealth({ jev: down });
    expect(h2.jev.breakerOpen).toBe(true);
    expect(h2.jev.reachable).toBe(false);
  });
});
