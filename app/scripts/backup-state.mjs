#!/usr/bin/env node
// ============================================================
// scripts/backup-state.mjs — v20.9.0 DAILY STATE BACKUP (Phase E)
// ------------------------------------------------------------
// AUDIT (E): "Backups: state/ ka daily snapshot." Ye script bot
// state (accounts, kill switches, arm configs, paper positions) +
// SAPTA journal + jev cache ka timestamped zip-snAPSHOT banata hai
// backups/ me, 14-din rotation ke saath.
//
// Windows Task Scheduler (RUN-FIRST.md):
//   schtasks /create /tn "SmartAI State Backup" /tr "node C:\smarttest\app\scripts\backup-state.mjs" /sc daily /st 23:30
// Ya watchdog ke saath: BACKUP_STATE_ON_BOOT=1
// ============================================================
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// v20.9.3 FIX (H3): default STATE_DIR galat jagah point karta tha —
// `server/data/bots` jabki code ka actual default (index.js:889,
// bots/routes.js:29, botRunner.js) `app/data/bots` hai. Har default
// local deployment pe `npm run backup-state` exit(2) "state dir nahi
// mila" deta tha — documented daily-backup flow DEAD tha (Docker
// unaffected, wahan BOT_STATE_DIR pinned hai). Ab wahi default jo
// runtime likhta hai.
const STATE_DIR = process.env.BOT_STATE_DIR || join(ROOT, 'data', 'bots');
const DATA_DIR = process.env.SMARTAI_DATA_DIR || join(ROOT, 'server', 'data');
// v20.9.0 fix: backups DATA_DIR ke andar jate hain (isolated test dirs ke
// saath bhi sahi jagah — pehle hamesha repo-default path pe likhta tha)
const BACKUP_DIR = process.env.SMARTAI_BACKUP_DIR || join(DATA_DIR, 'backups');
const KEEP = Number(process.env.SMARTAI_BACKUP_KEEP) || 14;

if (!existsSync(STATE_DIR)) {
  console.error(`backup-state: state dir nahi mila (${STATE_DIR}) — kuch backup nahi hua`);
  // v20.9.1 [M]: silently exit(0) ek drifted BOT_STATE_DIR ko hamesha ke
  // liye disable kar deta tha (Task Scheduler me kabhi notice hi nahi
  // hota). Empty-but-existing dir = benign (exit 0, niche handle hota
  // hai); MISSING dir = config error — non-zero exit taaki scheduler
  // alert kar sake.
  process.exit(2);
}
mkdirSync(BACKUP_DIR, { recursive: true });

// --- collect files (state tree + key journals) ---
const files = [];
function walk(dir, prefix = '') {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, `${prefix}${e}/`);
    else files.push({ abs: p, rel: `${prefix}${e}`, size: st.size });
  }
}
walk(STATE_DIR, 'state/');
for (const j of ['protrader-auto-journal.json', 'protrader-auto-config.json', 'ai-trading-config.json']) {
  const p = join(DATA_DIR, j);
  if (existsSync(p)) {
    let st; try { st = statSync(p); } catch { continue; }
    files.push({ abs: p, rel: `data/${j}`, size: st.size });
  }
}
if (!files.length) {
  console.error('backup-state: koi file nahi mili — skip');
  process.exit(0);
}

// --- tar-like simple archive: length-prefixed concat, gzipped ---
// (zero deps — Node stdlib only; restore: gunzip + split on markers)
// v20.9.1 [M]: ATOMIC write — tmp file me likho, finish pe rename. Direct
// final-name write crash/disk-full pe truncated archive chhodta tha jo
// (a) 14-rotation me 2 hafte ginta hai aur (b) restore attempt tak pakda
// nahi jaata.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = join(BACKUP_DIR, `smartai-state-${stamp}.tar.gz`);
const tmpPath = `${outPath}.tmp-${process.pid}`;
const out = createWriteStream(tmpPath);
const gz = createGzip({ level: 6 });
gz.pipe(out);

const MANIFEST = { stamp, files: files.map((f) => ({ rel: f.rel, size: f.size })) };
gz.write(Buffer.from(`SMARTAI-BACKUP-V1\n${JSON.stringify(MANIFEST)}\n`));
let pending = files.length;
for (const f of files) {
  const chunk = existsSync(f.abs) ? safeRead(f.abs) : Buffer.alloc(0);
  gz.write(Buffer.from(`\n---FILE ${f.rel} ${chunk.length}\n`));
  gz.write(chunk);
}
gz.end();

await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); gz.on('error', rej); });
// v20.9.1 [M]: tmp → final atomic rename (same-filesystem rename)
try { renameSync(tmpPath, outPath); } catch { try { unlinkSync(tmpPath); } catch { /* best-effort */ } console.error('backup-state: rename failed — backup discard'); process.exit(3); }

function safeRead(p) { try { return readFileSync(p); } catch { return Buffer.alloc(0); } }

// --- rotation ---
const backups = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('smartai-state-')).sort();
while (backups.length > KEEP) {
  const old = backups.shift();
  try { unlinkSync(join(BACKUP_DIR, old)); } catch { /* best-effort */ }
}
console.log(`backup-state: ${outPath} (${files.length} files, rotation ${backups.length}/${KEEP})`);
