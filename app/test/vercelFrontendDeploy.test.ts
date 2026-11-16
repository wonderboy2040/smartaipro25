// ============================================================
// test/vercelFrontendDeploy.test.ts — VERCEL FRONTEND DEPLOY LOCK
// ------------------------------------------------------------
// Vercel hosts the static frontend only; the Express API stays on the
// Node host. Two failure modes are pinned here:
//   1. No root package.json -> Vercel cannot detect the app. The root
//      vercel.json must build app/ and publish app/dist.
//   2. index.html used to bounce every *.vercel.app visit to Render.
//      That made a successful Vercel deploy look broken (and skipped
//      the Vercel frontend entirely). The API default now lives in
//      api.ts getProxyBase(), so a static deploy boots in place.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

describe('Vercel frontend deploy config', () => {
  it('repo-root vercel.json builds app/ and publishes app/dist', () => {
    const cfg = readJson(path.join(REPO_ROOT, 'vercel.json'));
    expect(cfg.framework).toBeNull();
    expect(cfg.installCommand).toContain('app');
    expect(cfg.installCommand).toContain('npm ci');
    expect(cfg.buildCommand).toContain('app');
    expect(cfg.outputDirectory).toBe('app/dist');
    expect(cfg.rewrites?.[0]?.destination).toBe('/index.html');
    expect(cfg.rewrites?.[0]?.source).toContain('api/');
  });

  it('app-root vercel.json publishes dist (Root Directory = app)', () => {
    const cfg = readJson(path.join(APP_ROOT, 'vercel.json'));
    expect(cfg.framework).toBeNull();
    expect(cfg.installCommand).toContain('npm ci');
    expect(cfg.outputDirectory).toBe('dist');
    expect(cfg.rewrites?.[0]?.destination).toBe('/index.html');
  });

  it('index.html does not redirect *.vercel.app away from the frontend', () => {
    const html = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
    expect(html).not.toContain('.vercel.app');
    expect(html).not.toContain('window.location.replace(');
  });

  it('Vercel/GH/Netlify hosts resolve the API through getProxyBase()', () => {
    const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'utils', 'api.ts'), 'utf8');
    expect(src).toContain("host.includes('.vercel.app')");
    expect(src).toContain('https://smartai1.onrender.com');
  });
});
