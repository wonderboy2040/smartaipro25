// ============================================================
// test/pinAuth.test.ts — v21.1.0 (Phase-3 split lock)
// ------------------------------------------------------------
// server/security/pinAuth.js extraction ka behavior contract:
//   • login: sahi PIN → session + cookie + token; galat PIN → 401
//   • per-IP limiter: 5 attempts/min → 6th 429
//   • global lockout: 150 failures → 429 sab IPs ke liye (sahi PIN bhi)
//   • logout: bearer-token logout session invalidate karta hai
//   • auth/check: query-param session ladder bhi detect hota hai
//   • requireAuth: bearer accept + no-auth 401 + service-token bypass
// Har case REAL ephemeral HTTP server pe chalta hai (mock nahi — jo
// express+body-parser+cookie的真实 behavior hi test karta hai).
// APP_PIN module-load pe capture hota hai — per-case vi.resetModules().
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

async function loadPinAuth(pin: string) {
  vi.resetModules();
  process.env.APP_PIN = pin;
  return await import('../server/security/pinAuth.js');
}

interface TestServer { server: Server; base: string; mod: any }

async function startApp(mod: any): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  mod.registerAuthRoutes(app, {
    clientIpOf: (req: any) => String(req.headers['x-test-ip'] || '1.1.1.1'),
    logoutOriginAllowed: () => true,
  });
  app.use(mod.requireAuth);
  app.get('/api/secret', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  return { server, base: `http://127.0.0.1:${(addr as any).port}`, mod };
}

async function stopApp(t: TestServer) {
  await new Promise<void>((r) => t.server.close(() => r()));
}

describe('server/security/pinAuth.js — v21.1.0 auth split contract', () => {
  afterEach(() => { delete process.env.APP_PIN; delete process.env.API_TOKEN; });

  it('login: correct PIN → 200 + sessionToken + httpOnly cookie; wrong PIN → 401', async () => {
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      const ok = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'TestPin12345' }) });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.ok).toBe(true);
      expect(typeof body.sessionToken).toBe('string');
      const setCookie = ok.headers.get('set-cookie') || '';
      expect(setCookie).toContain('HttpOnly');
      expect(mod.sessions.has(body.sessionToken)).toBe(true);

      const bad = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'WRONG' }) });
      expect(bad.status).toBe(401);
    } finally { await stopApp(t); }
  });

  it('per-IP limiter: 5 attempts/min → 6th 429 (global-lock ka nahi, per-IP ka)', async () => {
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      let last: Response | null = null;
      for (let i = 0; i < 6; i++) {
        last = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '9.9.9.9' }, body: JSON.stringify({ pin: 'x' }) });
      }
      expect(last!.status).toBe(429);
      const b = await last!.json();
      expect(b.error.message).toMatch(/Too many login attempts/i);
    } finally { await stopApp(t); }
  });

  it('v21.1.1 [audit A15]: 8 RAPID SUCCESSFUL logins → koi 429 NAHI (sirf failures count hote hain)', async () => {
    // Pehle successful logins bhi window me ginte the — rapid re-login burst
    // (SSE reconnect storm waghera) 429 de deta tha. Ab fail-only counting.
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      for (let i = 0; i < 8; i++) {
        const r = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '8.8.8.8' }, body: JSON.stringify({ pin: 'TestPin12345' }) });
        expect(r.status).toBe(200);
      }
    } finally { await stopApp(t); }
  });

  it('v21.1.1 [audit A15]: 5 failures ke baad sahi PIN bhi per-IP 429 (fail window sustained)', async () => {
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      for (let i = 0; i < 5; i++) {
        await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '7.7.7.7' }, body: JSON.stringify({ pin: 'x' }) });
      }
      const r = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '7.7.7.7' }, body: JSON.stringify({ pin: 'TestPin12345' }) });
      expect(r.status).toBe(429);
    } finally { await stopApp(t); }
  });

  it('global distributed lockout: 150 rotated-IP failures → even the CORRECT pin gets 429', async () => {
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      for (let i = 0; i < 150; i++) {
        const ip = `10.0.${i % 250}.${Math.floor(i / 250)}`;
        await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip }, body: JSON.stringify({ pin: 'x' }) });
      }
      const res = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '10.9.9.9' }, body: JSON.stringify({ pin: 'TestPin12345' }) });
      expect(res.status).toBe(429);
      const b = await res.json();
      expect(b.error.message).toMatch(/temporarily locked/i);
    } finally { await stopApp(t); }
  });

  it('requireAuth: bearer session → 200; no auth → 401; service token bypasses store', async () => {
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      const login = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'TestPin12345' }) });
      const { sessionToken } = await login.json();

      const ok = await fetch(`${t.base}/api/secret`, { headers: { authorization: `Bearer ${sessionToken}` } });
      expect(ok.status).toBe(200);

      const no = await fetch(`${t.base}/api/secret`);
      expect(no.status).toBe(401);

      process.env.API_TOKEN = 'svc-token-local-123';
      const svc = await fetch(`${t.base}/api/secret`, { headers: { authorization: 'Bearer svc-token-local-123' } });
      expect(svc.status).toBe(200);
      delete process.env.API_TOKEN;
    } finally { await stopApp(t); }
  });

  it('logout: bearer-token logout invalidates the session (cookie-less clients)', async () => {
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      const login = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'TestPin12345' }) });
      const { sessionToken } = await login.json();
      const out = await fetch(`${t.base}/api/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${sessionToken}` } });
      expect(out.status).toBe(200);
      expect(mod.sessions.has(sessionToken)).toBe(false);
      const after = await fetch(`${t.base}/api/secret`, { headers: { authorization: `Bearer ${sessionToken}` } });
      expect(after.status).toBe(401);
    } finally { await stopApp(t); }
  });

  it('auth/check: query-param session ladder bhi detect hota hai', async () => {
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      const login = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'TestPin12345' }) });
      const { sessionToken } = await login.json();
      const chk = await fetch(`${t.base}/api/auth/check?session=${encodeURIComponent(sessionToken)}`);
      expect(chk.status).toBe(200);
      const b = await chk.json();
      expect(b.authenticated).toBe(true);
    } finally { await stopApp(t); }
  });

  it('cross-site logout without Bearer → 403 (CSRF discriminator ported intact)', async () => {
    const mod = await loadPinAuth('TestPin12345');
    const t = await startApp(mod);
    try {
      const res = await fetch(`${t.base}/api/auth/logout`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' }, // koi Authorization header nahi
      });
      expect(res.status).toBe(403);
    } finally { await stopApp(t); }
  });
});
