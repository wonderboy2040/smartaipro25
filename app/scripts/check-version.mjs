// ============================================================
// check-version.mjs — v20.9.1 release gate (M — version drift)
// ------------------------------------------------------------
// src/version.ts ka APP_VERSION haath se maintain hota hai; package.json
// ka version bhi. Dono kabhi drift hue (ek chhoda, doosra bhoola) to
// har client permanently red "BUILD STALE" banner dikhata hai.
// Ye gate dono ko compare karke mismatch pe non-zero exit deta hai.
// Wired into `npm run check` (v20.9.1).
//
// v21.23.15: lockfiles bhi check hote hain — app/package-lock.json aur
// telegram-bot/package-lock.json ka root version apne package.json se
// match karna chahiye (stale lock version silent drift tha).
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const vt = readFileSync(path.join(root, 'src', 'version.ts'), 'utf8');
const m = vt.match(/APP_VERSION\s*=\s*'([^']+)'/);
const app = m ? m[1] : null;

if (!app || app !== pkg.version) {
  console.error(`[check-version] MISMATCH: package.json=${pkg.version} vs src/version.ts APP_VERSION=${app ?? '(not found)'}`);
  console.error('[check-version] dono ko same value pe set karo (version.ts + package.json).');
  process.exit(1);
}

function lockMismatch(label, lockPath, expected) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    console.error(`[check-version] ${label}: lockfile missing ya invalid JSON (${lockPath})`);
    return true;
  }
  const top = lock.version;
  const rootPkg = lock.packages?.['']?.version;
  const bad = (top && top !== expected) || (rootPkg && rootPkg !== expected);
  if (bad) {
    console.error(
      `[check-version] ${label} LOCK MISMATCH: package=${expected} lock.version=${top ?? '(none)'} lock.packages[""].version=${rootPkg ?? '(none)'}`,
    );
    console.error(`[check-version] ${path.relative(root, lockPath)} ko package.json ke saath sync karo.`);
    return true;
  }
  return false;
}

let failed = false;
failed = lockMismatch('app', path.join(root, 'package-lock.json'), pkg.version) || failed;

const tgRoot = path.join(root, 'telegram-bot');
const tgPkg = JSON.parse(readFileSync(path.join(tgRoot, 'package.json'), 'utf8'));
failed = lockMismatch('telegram-bot', path.join(tgRoot, 'package-lock.json'), tgPkg.version) || failed;

if (failed) process.exit(1);
console.log(`[check-version] OK — ${pkg.version} (app + telegram-bot ${tgPkg.version})`);
