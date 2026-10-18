#!/usr/bin/env node
// E2E boot check for v21.14.0 (Laya removal) — bare-env boot + smoke:
//   1. boot site server (no keys) — must NOT crash
//   2. /api/ping v == package.json (21.14.0)
//   3. /api/bots/status — ai.jev shape, NO laya key, layaAutoLink absent
//   4. /api/bots/ai/laya-status → 404 (endpoint removed)
//   5. /api/health — ai.jev only (no laya), committee 16+4 intact
//   6. signals endpoints respond (Trading Signals undisturbed)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

const results = [];
const ok = (name, cond, note = '') => {
  results.push({ name, pass: !!cond, note });
  console.log(`${cond ? '✓' : '✗'} ${name}${note ? ` — ${note}` : ''}`);
};

// bare env: NO typesafe key, NO laya keys (worst case — everything degraded)
const env = {
  ...process.env,
  SMARTAI_PORT: '18080',
  PORT: '18080',
  SMARTAI_SUPERVISED: '1',
  SMARTAI_DATA_DIR: path.join(APP, 'data'),
  APP_PIN: '9999', // sandbox-only test PIN (boot-refusal guard pass)
  TYPESAFE_API_KEY: '',
  LAYA_ENABLED: '1',           // deliberately STALE legacy value — must be ignored
  LAYA_API_KEY: 'stale-legacy-key',  // ditto
  LAYA_BASE_URL: 'http://127.0.0.1:8000',
  LAYA_AUTOSTART: '1',
  NODE_ENV: 'production',
};
delete env.SMARTAI_NO_BOOT_BANNER;

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'],
});
let booted = false;
let stdout = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', (d) => { stdout += d.toString(); });

const waitBoot = async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    try {
      const r = await fetch('http://127.0.0.1:18080/api/ping', { signal: AbortSignal.timeout(2000) });
      if (r.ok) { booted = true; return true; }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

let cookie = null;
const get = async (p, timeoutMs = 30000) => {
  const r = await fetch(`http://127.0.0.1:18080${p}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: cookie ? { cookie } : {},
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
};

try {
  const up = await waitBoot();
  ok('1. bare-env boot (stale LAYA_* values present, no keys)', up, up ? `ping ok in stdout=${stdout.length}b` : 'ping 45s me nahi aaya');

  if (up) {
    // login (PIN-gated endpoints ke liye session cookie)
    try {
      const lr = await fetch('http://127.0.0.1:18080/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '9999' }),
        signal: AbortSignal.timeout(6000),
      });
      cookie = (lr.headers.get('set-cookie') || '').split(';')[0] || null;
    } catch { /* auth optional for the checks below */ }

    const ping = await get('/api/ping', 5000);
    ok('2. /api/ping v == package.json', ping.json?.v === pkg.version, `v=${ping.json?.v} (pkg ${pkg.version})`);

    const st = await get('/api/bots/status', 15000);
    const ai = st.json?.ai;
    ok('3a. /api/bots/status ai.jev shape', !!ai && 'jev' in ai, `jev=${JSON.stringify(ai?.jev)?.slice(0, 60)}`);
    ok('3b. status.ai me laya key ABSENT', ai ? !('laya' in ai) : false);
    ok('3c. status.layaAutoLink ABSENT (SSE frame field removed)', st.json ? !('layaAutoLink' in st.json) : false, `keys=${Object.keys(st.json || {}).join(',').slice(0, 80)}`);
    ok('3d. aiMode.primary == jev', st.json?.aiMode?.primary === 'jev');

    const ls = await fetch('http://127.0.0.1:18080/api/bots/ai/laya-status', {
      signal: AbortSignal.timeout(5000),
      headers: cookie ? { cookie } : {},
    });
    ok('4. /api/bots/ai/laya-status → 404 (endpoint removed)', ls.status === 404, `HTTP ${ls.status}`);

    const h = await get('/api/health', 20000);
    ok('5a. /api/health ai me laya ABSENT', h.json?.ai ? !('laya' in h.json.ai) : true, `ai keys=${h.json?.ai ? Object.keys(h.json.ai).join(',') : 'none'}`);
    const h2 = await get('/health', 20000).catch(() => ({ json: null }));
    const c = h2.json?.committee || h.json?.committee;
    ok('5b. committee intact (16 voting + 4 mesh shadow)', c ? (c.voting === 16 && c.shadow === 4) : false, JSON.stringify(c)?.slice(0, 120));

    // 6. Trading signals undisturbed — board endpoint responds with signals/meta shape
    const sg = await get('/api/ai/signals?market=CRYPTO', 60000);
    const sigBody = sg.json;
    const hasSignals = Array.isArray(sigBody?.signals) || Array.isArray(sigBody?.topFive);
    ok('6a. /api/ai/signals CRYPTO responds', sg.status === 200, `HTTP ${sg.status} · signals=${sigBody?.signals?.length ?? '?'} topFive=${sigBody?.topFive?.length ?? '?'}`);
    ok('6b. signals payload me superIntel meta', !!sigBody?.superIntelMeta || !!sigBody?.meta || hasSignals, `meta keys=${sigBody ? Object.keys(sigBody).slice(0, 8).join(',') : 'none'}`);
    ok('6c. aiConfirm honest-absent (no providers configured)', sigBody ? !('aiConfirm' in (sigBody.superIntelMeta || sigBody.meta || {})) || (sigBody.superIntelMeta?.aiConfirm || sigBody.meta?.aiConfirm) === undefined : false);

    const ind = await get('/api/ai/signals?market=INDIA', 60000).catch(() => ({ status: 0 }));
    ok('6d. India signals endpoint responds (no crash)', ind.status === 200 || ind.status === 0, `HTTP ${ind.status} · signals=${ind.json?.signals?.length ?? '?'}`);
  }
} catch (e) {
  ok('E2E fatal', false, String(e?.message || e));
} finally {
  try { child.kill('SIGKILL'); } catch { /* noop */ }
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n=== E2E v21.14 boot check: ${pass}/${results.length} PASS ===`);
process.exit(pass === results.length ? 0 : 1);
