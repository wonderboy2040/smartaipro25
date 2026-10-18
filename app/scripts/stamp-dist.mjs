#!/usr/bin/env node
// ============================================================
// scripts/stamp-dist.mjs — v20.8.3 BUILD-STAMP WRITER
// ------------------------------------------------------------
// WHY THIS EXISTS (the "v20.7.5 serve" bug):
//   Server frontend ko SIRF dist/ (vite build output) se serve
//   karta hai, aur dist/ .gitignore me hai — code-zip me kabhi
//   nahi aata. User naya zip purane folder ke UPAR extract karta
//   hai -> naya SERVER code aa jata hai, par PURANA dist (jo
//   kabhi v20.7.5 pe build hua tha) serve hota rehta hai. UI
//   badge wahi purana version dikhata hai — "latest code run
//   nahi ho raha" ka exact root-cause yahi hai.
//
// CONTRACT:
//   * `npm run build` ke baad ye script (postbuild hook) dist/
//     me .build-version file likhti hai = package.json ka version.
//   * Supervisor (server/supervisor.js -> ensureFrontend) boot pe
//     ye stamp vs package.json version compare karta hai —
//     mismatch/missing = auto npm install + rebuild.
//   * Is tarah HAR update path (zip overlay, git pull, manual
//     copy) guaranteed fresh build tak le jata hai.
//
// Testable: DIST_DIR env override (hermetic tests temp dir use
// karte hain; production me hamesha app/dist).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const distDir = process.env.DIST_DIR
  ? path.resolve(process.env.DIST_DIR)
  : path.join(appRoot, 'dist');

function fail(msg) {
  try { process.stderr.write(`[stamp-dist] ${msg}\n`); } catch { /* noop */ }
  process.exit(1);
}

let version = null;
try {
  version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version || null;
} catch { /* handled below */ }
if (!version) fail(`package.json (${appRoot}) se version nahi mila — build gate fail`);

const indexHtml = path.join(distDir, 'index.html');
if (!fs.existsSync(indexHtml)) {
  fail(`dist/index.html nahi mila (${distDir}) — build pehle complete hona chahiye, stamp nahi likh sakte`);
}

try {
  fs.writeFileSync(path.join(distDir, '.build-version'), String(version), 'utf8');
} catch (err) {
  fail(`dist/.build-version likha nahi ja saka: ${String((err && err.message) || err)}`);
}
try { process.stdout.write(`[stamp-dist] dist/.build-version = ${version}\n`); } catch { /* noop */ }
