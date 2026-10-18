#!/usr/bin/env node
// ============================================================
// scripts/full-diagnostic.mjs — SmartAI Pro FULL SITE DIAGNOSTIC TOOL
// ------------------------------------------------------------
// Ek command me poore site ke sabhi features/functions deep-check:
//
//   node scripts/full-diagnostic.mjs              # static + live check
//   node scripts/full-diagnostic.mjs --boot        # server band ho to khud start
//   node scripts/full-diagnostic.mjs --quick       # fast mode (syntax+route sweep skip)
//   node scripts/full-diagnostic.mjs --markets INDIA,CRYPTO
//   node scripts/full-diagnostic.mjs --base http://localhost:8080
//
// SECTIONS:
//   A. Environment & Files   — node, .env keys (masked), deps, dist, data
//   B. Code Integrity        — syntax sweep, version triangle, API route wiring
//   C. Live Runtime          — server ping, /api/health, engines, signals
//                              (4 markets × sanity), expert picks, bot AI,
//                              exec, smoke endpoints
//   D. AI Confirm Layer      — board AI-confirmation status + measured
//                              EFFECT (v21.14: Laya removed — jev-only)
//
// Output: console + data/diagnostic-report-<timestamp>.txt
// Exit:   0 = sab OK (warnings allowed) | 1 = failures mile
// Secrets kabhi print nahi hote — sirf masked (first-4 + length).
// ============================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');            // app/
const DATA = join(ROOT, 'data');

const _args = process.argv.slice(2);
const OPT = {
  boot: _args.includes('--boot'),
  quick: _args.includes('--quick'),
  base: ((_args.find(a => a.startsWith('--base=')) || '').slice(7))
    || process.env.DIAG_BASE
    || `http://localhost:${(() => { const p = Number(process.env.PORT); return Number.isFinite(p) && p > 0 ? p : 8080; })()}`,
};
const _mk = (_args.find(a => a.startsWith('--markets=')) || '').slice(10);
const MARKETS = _mk ? _mk.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : ['INDIA', 'CRYPTO', 'FUTURES', 'GLOBALFUTURES'];

// ---------------- console/report framework ----------------
const _useColor = process.platform !== 'win32' || !!process.env.WT_SESSION || !!process.env.FORCE_COLOR;
const C = _useColor
  ? { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', end: '\x1b[0m' }
  : { ok: '', warn: '', fail: '', dim: '', bold: '', cyan: '', end: '' };
const _strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const _lines = [];
const COUNT = { pass: 0, warn: 0, fail: 0 };
const _t0 = Date.now();

function say(s = '') { console.log(s); _lines.push(_strip(s)); }
function section(title) {
  say('');
  say(`${C.bold}${C.cyan}━━━ ${title} ${'━'.repeat(Math.max(2, 64 - title.length))}${C.end}`);
}
function mark(kind, name, detail = '') {
  const tag = kind === 'pass' ? `${C.ok}[ OK ]${C.end}` : kind === 'warn' ? `${C.warn}[WARN]${C.end}` : `${C.fail}[FAIL]${C.end}`;
  COUNT[kind]++;
  say(`  ${tag} ${name}${detail ? ` ${C.dim}— ${detail}${C.end}` : ''}`);
}
function info(name, detail = '') { say(`  ${C.dim}[INFO]${C.end} ${name}${detail ? ` ${C.dim}— ${detail}${C.end}` : ''}`); }
function note(s = '') { say(`  ${C.dim}${s}${C.end}`); }
const mask = (v) => { const s = String(v ?? ''); return !s ? '(empty)' : `${s.slice(0, 4)}…len${s.length}`; };

// ---------------- helpers ----------------
function parseEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
// ---------------- auth (server PIN / service token) ----------------
// Sabhi live API calls authenticated hain (pinAuth middleware).
// Priority: 1) API_TOKEN service token (≥12 chars, loopback service auth)
//           2) APP_PIN login → sessionToken (real browser session jaisa)
let AUTH = { token: null, mode: null };
async function resolveAuth(ENV) {
  const svc = String(ENV.API_TOKEN ?? process.env.API_TOKEN ?? '');
  if (svc.length >= 12) {
    // verify karo ki token kaam karta hai
    try {
      const r = await fetch(`${OPT.base}/api/auth/check`, { headers: { Authorization: `Bearer ${svc}` }, signal: AbortSignal.timeout(5000) });
      const j = await r.json().catch(() => null);
      if (j?.authenticated) { AUTH = { token: svc, mode: 'API_TOKEN (service)' }; return; }
    } catch { /* pinAuth session-map mode — service token phir bhi middleware me pass hoga */ }
    AUTH = { token: svc, mode: 'API_TOKEN (service)' }; return;
  }
  const pin = String(ENV.APP_PIN ?? process.env.APP_PIN ?? '');
  if (pin) {
    try {
      const r = await fetch(`${OPT.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.sessionToken) { AUTH = { token: j.sessionToken, mode: 'APP_PIN login' }; return; }
    } catch { /* down server already reported */ }
  }
  AUTH = { token: null, mode: null };
}
async function jget(pathname, ms = 12000) {
  const r = await fetch(`${OPT.base}${pathname}`, {
    signal: AbortSignal.timeout(ms),
    headers: { 'Cache-Control': 'no-cache', ...(AUTH.token ? { Authorization: `Bearer ${AUTH.token}` } : {}) },
  });
  let j = null; try { j = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json: j };
}
function walk(dir, exts, out = []) {
  let entries; try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some(x => e.endsWith(x))) out.push(p);
  }
  return out;
}

// =====================================================================
// SECTION A — ENVIRONMENT & FILES
// =====================================================================
function sectionA(ENV) {
  section('A. ENVIRONMENT & FILES');
  const pkg = existsSync(join(ROOT, 'package.json')) ? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) : null;

  // A1 Node version
  const nv = process.versions.node;
  const [major] = String(nv).split('.').map(Number);
  if (major >= 18) mark('pass', `Node.js v${nv}`, 'native fetch + AbortSignal.timeout available');
  else mark('fail', `Node.js v${nv}`, 'v18+ chahiye — nvm/nodejs.org se upgrade karo');

  // A2 package.json
  if (pkg?.version) mark('pass', `package.json v${pkg.version}`, `"${pkg.name}"`);
  else mark('fail', 'package.json', 'padha nahi ja saka');

  // A3 .env key inventory (masked)
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    mark('warn', 'app/.env missing', 'server env-less chalega (providers off) — live keys ke saath .env banao');
  } else {
    const need = {
      TYPESAFE_API_KEY: 'Jev cloud provider (board AI-confirm; v21.14: Laya removed — ye ek matra provider hai)',
    };
    for (const [k, why] of Object.entries(need)) {
      const v = ENV[k];
      if (v === undefined) info(`.env ${k}`, `not set — ${why}`);
      else if (k.endsWith('_KEY')) mark(v ? 'pass' : 'warn', `.env ${k}`, v ? `configured ${mask(v)}` : 'empty — set karo');
      else info(`.env ${k}=${v}`, why);
    }
    const groww = Object.keys(ENV).filter(k => k.startsWith('GROWW_') && ENV[k]);
    if (groww.length) mark('pass', 'Groww Trading-API keys', groww.map(k => k.replace('GROWW_', '')).join(', '));
    else info('GROWW_* keys', 'not set — India 1s push tier OFF hai, public 1.5s tier chalega (normal)');
  }

  // A4 node_modules + critical deps
  const nm = join(ROOT, 'node_modules');
  if (!existsSync(nm)) mark('fail', 'node_modules missing', 'app/ ke andar `npm install` chalao');
  else {
    const deps = ['express', 'vite', 'vitest', 'react', 'lucide-react'].filter(d => existsSync(join(nm, d)));
    mark(deps.length === 5 ? 'pass' : 'warn', `node_modules (${deps.length}/5 critical deps)`, deps.join(', ') || 'koi critical dep nahi mila');
  }

  // A5 dist build + version stamp
  const distIdx = join(ROOT, 'dist', 'index.html');
  const bvFile = join(ROOT, 'dist', '.build-version');
  if (!existsSync(distIdx)) mark('fail', 'dist/index.html missing', 'frontend build nahi hai — `npm run build` chalao (ya watchdog auto-build karega)');
  else if (!existsSync(join(ROOT, 'dist', 'assets'))) mark('warn', 'dist/assets missing', 'build incomplete lagta hai');
  else mark('pass', 'dist/ build present');
  if (existsSync(bvFile)) {
    const bv = readFileSync(bvFile, 'utf8').trim();
    if (pkg?.version && bv === pkg.version) mark('pass', `dist/.build-version = v${bv}`, 'package.json se match');
    else mark('warn', `dist/.build-version v${bv} ≠ package v${pkg?.version}`, 'watchdog ensureFrontend auto-rebuild karega (ya `npm run build`)');
  } else mark('fail', 'dist/.build-version missing', 'stamp-dist.mjs nahi chala — `npm run build` chalao');

  // A6 data dir writable
  try {
    if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
    const probe = join(DATA, '.diag-probe');
    writeFileSync(probe, String(Date.now()));
    rmSync(probe, { force: true });
    mark('pass', 'data/ directory writable', join('data'));
  } catch (e) { mark('fail', 'data/ not writable', String(e?.message || e)); }

  // A7 watchdog/launcher stack
  const stack = [
    ['Start-SmartAI-Watchdog.bat', 'Windows watchdog launcher'],
    ['server/supervisor.js', 'supervisor (ping/kill/restart)'],
  ];
  for (const [f, why] of stack) {
    if (existsSync(join(ROOT, f))) mark('pass', f, why);
    else mark('fail', `${f} missing`, why);
  }
  // A8 telegram bot (optional)
  if (existsSync(join(ROOT, 'telegram-bot', 'bot.mjs'))) mark('pass', 'telegram-bot/', 'optional T-bot present');
  else info('telegram-bot/', 'not present (optional — start:telegram skip)');
}

// =====================================================================
// SECTION B — CODE INTEGRITY (skipped by --quick)
// =====================================================================
function sectionB() {
  section('B. CODE INTEGRITY');
  if (OPT.quick) { note('skipped (--quick)'); return; }

  // B1 syntax sweep — every server file + script must parse
  const files = [
    ...walk(join(ROOT, 'server'), ['.js']),
    ...walk(join(ROOT, 'scripts'), ['.mjs', '.js']),
  ];
  const bad = [];
  let done = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 15000 });
    done++;
    if (r.status !== 0) bad.push(`${relative(ROOT, f)}: ${(r.stderr || '').split('\n')[0] || 'parse error'}`);
  }
  if (bad.length === 0) mark('pass', `syntax sweep: ${done} server/script files`, 'sab parse ho gaye (node --check)');
  else for (const b of bad) mark('fail', 'syntax error', b);

  // B2 version triangle: package.json ↔ src/version.ts ↔ dist/.build-version
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const vt = readFileSync(join(ROOT, 'src', 'version.ts'), 'utf8');
  const m = vt.match(/APP_VERSION\s*=\s*'([^']+)'/);
  const bv = existsSync(join(ROOT, 'dist', '.build-version')) ? readFileSync(join(ROOT, 'dist', '.build-version'), 'utf8').trim() : null;
  const srcV = m ? m[1] : null;
  if (pkg.version === srcV && pkg.version === bv) mark('pass', `version triangle v${pkg.version}`, 'package.json = src/version.ts = dist stamp');
  else mark('warn', `version mismatch`, `package=${pkg.version} src=${srcV} dist=${bv} — watchdog auto-rebuild karega`);

  // B3 API route wiring (frontend call ↔ backend route regression)
  const rr = spawnSync(process.execPath, ['scripts/check-api-routes.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  if (rr.status === 0) mark('pass', 'API route wiring', 'har frontend /api call ka backend route hai');
  else {
    const tail = (rr.stdout || '').trim().split('\n').filter(l => /ERROR/i.test(l)).slice(0, 6);
    mark('fail', 'API route wiring', tail.join(' | ') || `exit ${rr.status} — \`npm run check:routes\` chalao`);
  }

  // B4 dist asset sanity
  try {
    const idx = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');
    const hasRoot = /id="root"/.test(idx);
    const assets = readdirSync(join(ROOT, 'dist', 'assets')).filter(f => f.endsWith('.js'));
    if (hasRoot && assets.length) mark('pass', `dist assets (${assets.length} js chunks)`, 'index.html + bundled JS theek');
    else mark('fail', 'dist asset sanity', hasRoot ? 'assets js missing' : 'index.html me #root nahi');
  } catch (e) { mark('fail', 'dist asset sanity', String(e?.message || e)); }
}

// =====================================================================
// SECTION C — LIVE RUNTIME
// =====================================================================
const AI_EFFECT = { stamps: 0, jevAgree: 0, jevDisagree: 0, jevNeutral: 0, confirmed: 0, conflict: 0, neutral: 0, stale: 0 };

async function pingServer(ms = 4000) {
  try { const r = await fetch(`${OPT.base}/api/ping`, { signal: AbortSignal.timeout(ms) }); return r.ok; } catch { return false; }
}

async function sectionC(ENV) {
  section('C. LIVE RUNTIME (server)');

  // C0 ping / auto-boot
  let up = await pingServer();
  let child = null;
  if (!up && OPT.boot) {
    note('server down — --boot mode: khud start kar rahe hain (pehli baar board compute me time lagega)…');
    child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(new URL(OPT.base).port || 8080) } });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 1500)); up = await pingServer(2500); }
    if (up) mark('pass', 'server boot (--boot)', `khud start ho gaya: ${OPT.base}`);
    else { mark('fail', 'server boot (--boot)', '75s me /api/ping nahi aaya — `npm start` haath se chalao, error dekho'); }
  } else if (!up) {
    mark('warn', 'server NOT running', `is machine pe ${OPT.base} pe koi server nahi — Start-SmartAI-Watchdog.bat chalao, YA phir dobara chalao: node scripts/full-diagnostic.mjs --boot`);
  } else {
    const r = await jget('/api/ping', 5000);
    mark('pass', 'server ping OK', `/api/ping → v${r.json?.v ?? r.json?.version ?? '?'}`);
  }
  if (!up) { note('live checks skip ho rahe hain (server down). Static sections (A/B/D-file) phir bhi chale. --boot ke saath full check milega.'); return { child, up: false }; }

  // C0.5 auth resolve (401 server pe sab API locked hai)
  await resolveAuth(ENV);
  if (AUTH.token) info(`server auth: ${AUTH.mode}`, 'sabhi live checks authenticated');
  else mark('warn', 'server auth FAIL', '.env me API_TOKEN (≥12 chars) ya APP_PIN nahi mila — live endpoints 401 de denge');

  // C1 /api/health — full snapshot
  try {
    const { status, json: h } = await jget('/api/health', 20000);
    if (status !== 200 || !h) throw new Error(`HTTP ${status}`);
    mark('pass', '/api/health snapshot', `uptime ${Math.round((h.uptimeSec || 0) / 60)}m · mem ${h.memoryMB || '?'}MB · ok=${h.ok}`);
    // feeds
    const srcs = Object.entries(h.feeds?.sources || {});
    const live = srcs.filter(([, v]) => v?.live).length;
    if (srcs.length) info(`market feeds: ${live}/${srcs.length} live`, srcs.map(([k, v]) => `${k}${v?.live ? '✓' : '·'}`).join(' '));
    if (Array.isArray(h.feeds?.staleSources) && h.feeds.staleSources.length) mark('warn', 'stale feed sources', h.feeds.staleSources.join(', ') + ' (India sources market-closed pe stale hona NORMAL hai)');
    const ws = h.feeds?.ws || {};
    for (const [k, v] of Object.entries(ws)) {
      if (!v) continue;
      if (v.healthy === true) mark('pass', `WebSocket ${k}`, `live · age ${v.ageSec ?? v.ageMs ?? '?'}s`);
      else if (v.armed === false) info(`WebSocket ${k}`, 'IDLE (koi subscriber nahi — by design, error nahi)');
      else mark('warn', `WebSocket ${k} down`, `failStreak ${v.failStreak ?? '?'}${v.cooldownReason ? ` · ${v.cooldownReason}` : ''} — REST fallback chal raha hai`);
    }
    if (h.feeds?.growwApi) {
      const g = h.feeds.growwApi;
      if (g.healthy === true) mark('pass', 'Groww Trading-API (India 1s tier)', `active${g.latencyMs ? ` · ${g.latencyMs}ms` : ''}`);
      else if (g.armed === false || g.configured === false) info('Groww Trading-API', 'not armed (public 1.5s tier) — normal, GROWW_* keys .env me daalo to 1s tier milega');
      else mark('warn', 'Groww Trading-API', `breakerActive=${g.breakerActive} — public tier sambhal lega`);
    }
    // kills
    const kx = h.kills || {};
    if (kx.aiDesk?.enabled === true) mark('warn', 'AI-Desk kill switch ON', 'signals disabled hain — UI se ya .env se off karo');
    if (kx.exec?.isKilled === true) mark('warn', `exec kill: ${kx.exec.level}`, String(kx.exec.reason || ''));
    if (kx.botLab?.globalPause === true) mark('warn', 'Bot Lab global pause ON', 'bots paused hain');
  } catch (e) { mark('fail', '/api/health', String(e?.message || e)); }

  // C2 engines + ollama
  try {
    const { status, json: j } = await jget('/api/ai/engines', 20000);
    if (status === 200 && j?.engines) {
      const en = Object.values(j.engines);
      const ready = en.filter(x => x?.state === 'ready' || x?.ok === true).length;
      mark(ready > 0 ? 'pass' : 'warn', `AI language engines (${ready}/${en.length} ready)`, j.ollama?.reachable ? 'local ollama reachable' : 'ollama off (cloud engines chalenge)');
    } else mark('warn', '/api/ai/engines', `HTTP ${status}`);
  } catch (e) { mark('warn', '/api/ai/engines', String(e?.message || e)); }

  // C3 /api/ai/status
  try {
    const { status } = await jget('/api/ai/status', 20000);
    mark(status === 200 ? 'pass' : 'fail', '/api/ai/status', `HTTP ${status}`);
  } catch (e) { mark('warn', '/api/ai/status', String(e?.message || e)); }

  // C4 SIGNAL BOARDS — 4 markets × deep sanity (sabse important check)
  for (const mkt of MARKETS) {
    try {
      const { status, json: b } = await jget(`/api/ai/signals?market=${mkt}&limit=15`, 90000);
      if (status !== 200 || !b) throw new Error(`HTTP ${status}`);
      const sigs = Array.isArray(b.signals) ? b.signals : [];
      if (sigs.length === 0) { mark('warn', `${mkt} board: 0 signals`, 'market band / scan khali — thodi der baad rescan'); continue; }
      const issues = [];
      let stamped = 0;
      for (const s of sigs) {
        const t = s?.symbol || '?';
        if (s?.side !== 'LONG' && s?.side !== 'SHORT') issues.push(`${t}: side="${s?.side}" invalid`);
        const sc = Number(s?.superIntel?.aiScore ?? s?.score);
        if (Number.isFinite(sc) && (sc < 0 || sc > 100)) issues.push(`${t}: score ${sc} range-out`);
        const p = s?.plan;
        if (p && Number(p.entry) > 0) {
          const e = Number(p.entry), sl = Number(p.stopLoss), t1 = Number(p.target1);
          if (s?.side === 'LONG' && Number.isFinite(sl) && sl > 0 && sl >= e) issues.push(`${t}: LONG me SL(${sl}) ≥ entry(${e}) — galat direction!`);
          if (s?.side === 'LONG' && Number.isFinite(t1) && t1 > 0 && t1 <= e) issues.push(`${t}: LONG me T1(${t1}) ≤ entry(${e})`);
          if (s?.side === 'SHORT' && Number.isFinite(sl) && sl > 0 && sl <= e) issues.push(`${t}: SHORT me SL(${sl}) ≤ entry(${e}) — galat direction!`);
          if (s?.side === 'SHORT' && Number.isFinite(t1) && t1 > 0 && t1 >= e) issues.push(`${t}: SHORT me T1(${t1}) ≥ entry(${e})`);
        }
        if (s?.grade && !['STRONG', 'ACTION', 'WATCH', 'NEUTRAL'].includes(String(s.grade).toUpperCase())) issues.push(`${t}: grade="${s.grade}" unknown`);
        const a = s?.aiConfirm;
        if (a) {
          stamped++;
          if (!['CONFIRMED', 'CONFLICT', 'NEUTRAL'].includes(a.verdict)) issues.push(`${t}: aiConfirm.verdict="${a.verdict}"`);
          for (const prov of ['jev']) {
            if (a[prov] != null && !['AGREE', 'DISAGREE', 'NEUTRAL'].includes(a[prov])) issues.push(`${t}: aiConfirm.${prov}="${a[prov]}"`);
          }
          if (a.jev === 'AGREE') AI_EFFECT.jevAgree++;
          else if (a.jev === 'DISAGREE') AI_EFFECT.jevDisagree++;
          else if (a.jev === 'NEUTRAL') AI_EFFECT.jevNeutral++;
          if (a.stale) AI_EFFECT.stale++;
          if (a.verdict === 'CONFIRMED') AI_EFFECT.confirmed++;
          else if (a.verdict === 'CONFLICT') AI_EFFECT.conflict++;
          else AI_EFFECT.neutral++;
        }
      }
      AI_EFFECT.stamps += stamped;
      const sides = sigs.map(s => s?.side === 'SHORT' ? 'S' : s?.side === 'LONG' ? 'L' : '?').join('');
      const grades = sigs.filter(s => s?.grade === 'STRONG').length;
      if (issues.length === 0) mark('pass', `${mkt} board: ${sigs.length} signals sane`, `sides ${sides} · STRONG ${grades} · AI-stamped ${stamped}`);
      else { for (const x of issues.slice(0, 5)) mark('fail', `${mkt} signal issue`, x); }
    } catch (e) { mark('fail', `${mkt} board fetch`, String(e?.message || e)); }
  }

  // C5 expert picks
  try {
    const { status, json: p } = await jget('/api/ai/expert-picks', 45000);
    const picks = p?.picks || p?.signals || p;
    const n = Array.isArray(picks) ? picks.length : -1;
    if (status === 200 && n >= 0) mark(n > 0 ? 'pass' : 'warn', `expert picks: ${n}`, n > 0 ? 'desk ke top expert signals' : 'abhi khali');
    else mark('warn', 'expert picks', `HTTP ${status}`);
  } catch (e) { mark('warn', 'expert picks', String(e?.message || e)); }

  // C6 Bot Lab AI provider (jev registry health)
  try {
    const { status, json: h } = await jget('/api/bots/ai/health', 15000);
    if (status !== 200 || !h) throw new Error(`HTTP ${status}`);
    for (const prov of ['jev']) {
      const v = h[prov];
      if (!v?.configured) { info(`Bot-Lab provider ${prov}`, 'not configured'); continue; }
      if (v.breakerOpen) mark('warn', `Bot-Lab ${prov}`, `breaker OPEN (p95 ${v.p95 ?? '?'}ms, errors ${v.errors}) — provider thoda rest karega`);
      else mark('pass', `Bot-Lab ${prov} healthy`, `p50 ${v.p50 ?? '?'}ms · calls ${v.calls} · cache ${v.cacheHits} · rejects ${v.rejects}${v.model ? ` · ${v.model}` : ''}`);
    }
  } catch (e) { mark('warn', 'Bot-Lab AI health', String(e?.message || e)); }

  // C7 smoke endpoints (must answer HTTP 200)
  const smokes = ['/api/exec/status', '/api/ai/agent', '/api/intraday-universe', '/api/intraday-paper', '/api/ai/trading/state'];
  for (const p of smokes) {
    try {
      const { status } = await jget(p, 15000);
      mark(status === 200 ? 'pass' : 'warn', `smoke ${p}`, `HTTP ${status}`);
    } catch (e) { mark('warn', `smoke ${p}`, String(e?.message || e)); }
  }
  // expert ML service — OPTIONAL feature, 503 = honest degrade
  try {
    const { status } = await jget('/api/ai/expert/status', 8000);
    if (status === 200) mark('pass', 'expert ML service (finbert/chronos)', 'reachable');
    else if (status === 503) info('expert ML service', 'down (503) — OPTIONAL feature, models download se on hota hai');
    else mark('warn', 'expert ML service', `HTTP ${status}`);
  } catch (e) { info('expert ML service', 'down — OPTIONAL feature'); }
  return { child, up: true };
}

// =====================================================================
// SECTION D — AI CONFIRM LAYER (JEV) + board effect measurement
// v21.14: Laya permanently removed — ye section ab sirf jev confirm
// layer ka live status + boards par measured effect dikhati hai.
// =====================================================================
async function sectionD(ENV) {
  section('D. AI CONFIRM LAYER (JEV) — TRADING SIGNALS PAR EFFECT');
  const key = ENV.TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY ?? '';
  const confirmMode = String(ENV.AI_BOARD_CONFIRM ?? 'auto').toLowerCase();

  // D1 config
  if (!key) mark('warn', 'TYPESAFE_API_KEY not set', 'Jev (cloud) provider configured nahi — board AI-confirm layer inactive rahega (signals normal chalenge)');
  else mark('pass', 'Jev provider configured', 'TYPESAFE_API_KEY set — board confirm layer armed');

  // D2 board AI-confirm layer status (live)
  try {
    const { json: h } = await jget('/api/health', 20000);
    const bc = h?.ai?.boardConfirm;
    if (bc?.active) mark('pass', `board AI-confirm layer ACTIVE`, `mode ${bc.mode} · providers [${(bc.providers || []).join(',')}] · top-${bc.n} @ score≥${bc.minScore}`);
    else if (bc) mark('warn', 'board AI-confirm layer INACTIVE', `mode ${bc.mode} · providers [${(bc.providers || []).join(',') || 'none'}] — TYPESAFE_API_KEY config check karo`);
  } catch { /* health already reported */ }

  // D3 measured effect on current boards
  if (AI_EFFECT.stamps > 0) {
    mark('pass', `AI effect on boards: ${AI_EFFECT.stamps} signals AI-stamped`,
      `Jev AGREE ${AI_EFFECT.jevAgree} · DISAGREE ${AI_EFFECT.jevDisagree} · NEUTRAL ${AI_EFFECT.jevNeutral}`);
    info('verdict spread', `CONFIRMED ${AI_EFFECT.confirmed} · CONFLICT ${AI_EFFECT.conflict} · NEUTRAL ${AI_EFFECT.neutral}${AI_EFFECT.stale ? ` · stale-serve ${AI_EFFECT.stale} (SWRV)` : ''}`);
    note('isaka matlab: Jev har CONFIRMED signal ka aiScore +3 karta hai (rank upar), har CONFLICT me −8 + STRONG→ACTION demote (rank girata hai + TOP-5 se bahar). Side/SL/size kabhi nahi badalta.');
  } else if (key) {
    mark('warn', 'abhi koi signal AI-stamped nahi', 'board confirm sirf top STRONG/ACTION score 75+ signals pe chalta hai — market ghusegi tab stamps dikhenge (5 min ruk ke rescan)');
  } else {
    info('AI-stamped signals', 'none (provider configured nahi)');
  }

  // D4 guidance
  note('');
  note('SITE PE AI EFFECT KAISE DEKHE (manual):');
  note('  1. Signal card pe chip: "🤖 AI ✓ (Jev ✓)" = provider ne confirm (+3 score) | "🤖 AI ✗" = ulta side (−8) | "🤖 AI ○" = abstain');
  note('  2. Chip pe hover karke tooltip me poori detail — provider kya bola');
  note('  3. OpsHealthStrip (top bar) ka AI chip — Jev latency/p95/breaker live');
  note('  4. Browser me kholo: http://localhost:8080/api/bots/ai/health — jev { calls, cacheHits, errors, breakerOpen }');
  note('  5. A/B proof chahiye: .env me AI_BOARD_CONFIRM=off karke server restart → board ranks compare karo (AI band vs on)');
  note(`  6. Board confirm mode abhi: AI_BOARD_CONFIRM=${confirmMode} (off = layer band)`);
}

// =====================================================================
// MAIN
// =====================================================================
function finish() {
  const secs = Math.round((Date.now() - _t0) / 1000);
  say('');
  say(`${C.bold}${'━'.repeat(70)}${C.end}`);
  say(`${C.bold}SUMMARY${C.end}  ${C.ok}PASS ${COUNT.pass}${C.end} · ${C.warn}WARN ${COUNT.warn}${C.end} · ${C.fail}FAIL ${COUNT.fail}${C.end}  ${C.dim}(${secs}s)${C.end}`);
  const verdict = COUNT.fail === 0
    ? `${C.ok}${C.bold}✔ ALL SYSTEMS OK${C.end}${COUNT.warn ? ` ${C.dim}— ${COUNT.warn} warning(s) dhyan se padho${C.end}` : ''}`
    : `${C.fail}${C.bold}✘ ${COUNT.fail} FAILURE(S) mile — upar ke [FAIL] lines fix karo${C.end}`;
  say(`  ${verdict}`);
  // report file
  try {
    const ts = new Date();
    const p = join(DATA, `diagnostic-report-${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}.txt`);
    if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
    writeFileSync(p, `SmartAI Pro FULL SITE DIAGNOSTIC — ${new Date().toISOString()}\nbase: ${OPT.base}\nmarkets: ${MARKETS.join(',')}\n${'='.repeat(70)}\n${_lines.join('\n')}\n${'='.repeat(70)}\nVERDICT: ${COUNT.fail === 0 ? 'ALL OK' : COUNT.fail + ' FAILURES'} (pass ${COUNT.pass} / warn ${COUNT.warn} / fail ${COUNT.fail})\n`);
    say(`  ${C.dim}report saved: ${relative(ROOT, p)}${C.end}`);
  } catch { /* report best-effort */ }
  say('');
  process.exitCode = COUNT.fail === 0 ? 0 : 1;
}

const ENV = { ...parseEnv(join(ROOT, '.env')) };
sectionA(ENV);
sectionB();
const live = await sectionC(ENV);
await sectionD(ENV);
if (live?.child) {
  note('');
  note('diagnostic boot kiya tha — server band kar rahe hain (watchdog chahiye to apna wala chalao)…');
  try { live.child.kill('SIGTERM'); } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 2500));
  try {
    if (process.platform === 'win32' && live.child.pid) spawnSync('taskkill', ['/PID', String(live.child.pid), '/T', '/F'], { stdio: 'ignore' });
    else live.child.kill('SIGKILL');
  } catch { /* already gone */ }
}
finish();
