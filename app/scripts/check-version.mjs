// ============================================================
// check-version.mjs — v20.9.1 release gate (M — version drift)
// ------------------------------------------------------------
// src/version.ts ka APP_VERSION haath se maintain hota hai; package.json
// ka version bhi. Dono kabhi drift hue (ek chhoda, doosra bhoola) to
// har client permanently red "BUILD STALE" banner dikhata hai.
// Ye gate dono ko compare karke mismatch pe non-zero exit deta hai.
// Wired into `npm run check` (v20.9.1).
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const vt = readFileSync(path.join(here, '..', 'src', 'version.ts'), 'utf8');
const m = vt.match(/APP_VERSION\s*=\s*'([^']+)'/);
const app = m ? m[1] : null;

if (!app || app !== pkg.version) {
  console.error(`[check-version] MISMATCH: package.json=${pkg.version} vs src/version.ts APP_VERSION=${app ?? '(not found)'}`);
  console.error('[check-version] dono ko same value pe set karo (version.ts + package.json).');
  process.exit(1);
}
console.log(`[check-version] OK — ${pkg.version}`);
