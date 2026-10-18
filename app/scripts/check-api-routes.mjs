#!/usr/bin/env node
// ============================================================
// scripts/check-api-routes.mjs — endpoint ↔ route regression check
// ------------------------------------------------------------
// The audit that found the orphaned intraday tree (v9.1) ran this
// check BY HAND — this script makes it a one-command guard:
//
//   1. Walks src/**/*.{ts,tsx} for every apiFetch(...) call and every
//      new EventSource(...) URL that targets /api/...
//   2. Extracts every app.<verb>(...) / router.<verb>(...) route
//      registered in server/**/*.js (incl. :param and `${...}`
//      dynamic segments)
//   3. Cross-checks:
//        frontend call with NO backend route  → ERROR (exit 1)
//        backend route no frontend calls       → INFO (some serve the
//          telegram bot / external clients / owner endpoints)
//
// Usage:  node scripts/check-api-routes.mjs     (or npm run check:routes)
// ============================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, exts, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, exts, out);
    else if (exts.some(x => e.endsWith(x))) out.push(p);
  }
  return out;
}

/** locate the /api/... path inside a raw call string. `${...}`
 *  interpolations become `*` segments when they ARE a whole path
 *  segment (`/api/quote/${sym}`), and are dropped when they are a
 *  query/suffix glued to a segment (`/api/x${force ? '?f=1' : ''}`).
 *  The marker dance keeps a ternary `?` inside interpolations from
 *  being mistaken for the query separator. */
function normalize(raw) {
  let s = raw;
  const i = s.indexOf('/api/');
  if (i === -1) return null;
  s = s.slice(i).replace(/\$\{[^}]*\}/g, '«JS»');
  s = s.split('?')[0];
  s = s.split('/').map(seg =>
    seg === '«JS»' ? '*' : seg.replace(/«JS»/g, '')).join('/');
  s = s.replace(/\/+/g, '/').replace(/\/$/, '');
  return s === '/api' ? null : s;
}

// KNOWN ORPHANS — pre-existing debt this check SURFACED on its first run
// (2026-09 v9.1): ResearchLabTab.tsx was an unimported experiment whose
// backend routes were never built. v11.7 cleanup DELETED that tab, so these
// routes no longer have any frontend caller at all — they are allowlisted
// here (backend routes with no frontend) so the gate stays green for
// REGRESSIONS (a NEW call to a missing route still fails).
const KNOWN_ORPHANS = new Set([
  '/api/journal/analyze',
  '/api/patterns/detect',
  '/api/thesis/*',
  '/api/schedule/*',
  '/api/broker/status',
  '/api/broker/dhan/holdings',
  '/api/broker/shoonya/holdings',
]);

// ---------- 1. frontend calls ----------
const feFiles = walk(join(ROOT, 'src'), ['.ts', '.tsx']);
const feCalls = new Map(); // path -> [{ file, verb }]
let unresolved = 0;
const CALL_RE = /apiFetch\s*\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/gs;
// EventSource: the URL may be an inline template OR built into a local
// first (`const streamUrl = \`.../api/...\`; new EventSource(streamUrl)`).
// Scan a window around each `new EventSource(` for /api/ strings.
const ES_RE = /new\s+EventSource\s*\(/g;
const URL_RE = /['"`]([^'"`\r\n]*\/api\/[^'"`\r\n]*)['"`]/g;

for (const f of feFiles) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  for (const m of src.matchAll(CALL_RE)) {
    const p = normalize(m[2]);
    if (!p) { unresolved++; continue; }
    // verb: peek at the options object that follows the first arg
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 220);
    const verb = /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/.exec(after)?.[1] || 'GET';
    if (!feCalls.has(p)) feCalls.set(p, []);
    feCalls.get(p).push({ file: rel, verb });
  }
  for (const esm of src.matchAll(ES_RE)) {
    // window: 300 chars before (the `const url = \`...\`` preamble) + the call
    const from = Math.max(0, esm.index - 300);
    const window = src.slice(from, esm.index + 250);
    for (const um of window.matchAll(URL_RE)) {
      const p = normalize(um[1]);
      if (!p) continue;
      if (!feCalls.has(p)) feCalls.set(p, []);
      feCalls.get(p).push({ file: rel, verb: 'SSE' });
    }
  }
}

// ---------- 2. backend routes ----------
const beFiles = walk(join(ROOT, 'server'), ['.js']);
const beRoutes = new Set();
const ROUTE_RE = /\b(?:app|router)\.(get|post|put|delete|all)\s*\(\s*(['"`])((?:(?!\2)[\s\S])*?)\2/gs;
const beVerbs = new Map(); // path -> Set(verbs)
for (const f of beFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(ROUTE_RE)) {
    let p = m[3].replace(/\$\{[^}]*\}/g, '*').split('?')[0];
    if (!p.startsWith('/api/')) continue;
    beRoutes.add(p);
    if (!beVerbs.has(p)) beVerbs.set(p, new Set());
    beVerbs.get(p).add(m[1].toUpperCase());
  }
}

// ---------- 3. cross-check ----------
const segs = (p) => p.split('/').filter(s => s !== '');
function matches(pattern, concrete) {
  const a = segs(pattern), b = segs(concrete);
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === '*' || s.startsWith(':') || s === b[i]);
}

const beList = [...beRoutes];
const errors = [];
const orphaned = [];
for (const [path, hits] of feCalls) {
  if (KNOWN_ORPHANS.has(path)) { orphaned.push({ path, hits }); continue; }
  if (!beList.some(r => matches(r, path))) errors.push({ path, hits });
}

// verb sanity: a POST frontend call on a route that only exists as GET
const warnings = [];
for (const [path, hits] of feCalls) {
  const verbs = [...beVerbs.entries()].filter(([r]) => matches(r, path)).flatMap(([, v]) => [...v]);
  if (!verbs.length) continue;
  for (const h of hits) {
    if (h.verb === 'SSE' || h.verb === 'GET') continue;
    if (verbs.includes(h.verb) || verbs.includes('ALL')) continue;
    warnings.push(`${h.verb} ${path} (${h.file}) — route only registers: ${verbs.join(',')}`);
  }
}

// ---------- report ----------
const fmt = (p) => `\x1b[36m${p}\x1b[0m`;
console.log('═'.repeat(72));
console.log('API endpoint ↔ route cross-check');
console.log('═'.repeat(72));
console.log(`frontend files scanned : ${feFiles.length}`);
console.log(`frontend /api/ calls    : ${feCalls.size} distinct paths (${[...feCalls.values()].reduce((n, v) => n + v.length, 0)} call sites)`);
if (unresolved) console.log(`dynamic (unresolved)    : ${unresolved} call sites pass a variable — not statically checkable`);
console.log(`backend route patterns : ${beList.length} (from ${beFiles.length} server files)`);

if (errors.length) {
  console.log(`\n\x1b[31m✖ MISSING ROUTES (${errors.length}):\x1b[0m`);
  for (const e of errors) {
    console.log(`  ✖ ${fmt(e.path)}`);
    for (const h of e.hits.slice(0, 4)) console.log(`      ← ${h.file} [${h.verb}]`);
  }
} else {
  console.log('\n\x1b[32m✔ every frontend /api/ call has a registered backend route\x1b[0m');
}

if (warnings.length) {
  console.log(`\n\x1b[33m⚠ VERB MISMATCH (${warnings.length}):\x1b[0m`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}

if (orphaned.length) {
  console.log(`\n\x1b[33m◐ KNOWN ORPHANED calls (${orphaned.length}) — allowlisted backend routes with no frontend caller (v11.7 cleanup deleted their last callers):\x1b[0m`);
  for (const o of orphaned) console.log(`  ◐ ${o.path}  ← ${o.hits[0]?.file}`);
}

const uncalled = beList.filter(r => ![...feCalls.keys()].some(c => matches(r, c)));
if (uncalled.length) {
  console.log(`\nℹ backend routes with no direct frontend call (${uncalled.length}) — telegram-bot / owner / server-internal served:`);
  for (const r of uncalled.sort()) console.log(`  · ${r}`);
}

console.log('═'.repeat(72));
if (errors.length) {
  console.log('\x1b[31mRESULT: FAIL — frontend calls a route that does not exist.\x1b[0m');
  process.exit(1);
}
console.log('\x1b[32mRESULT: PASS\x1b[0m');
