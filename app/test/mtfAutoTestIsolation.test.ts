// ============================================================
// test/mtfAutoTestIsolation.test.ts — v21.24.0 TEST-INFRA REGRESSION
// ------------------------------------------------------------
// v21.24.0 se pehle kuch suites (siteRecheck212312/212313,
// directionConflict) bina apna MTF_AUTO_DATA_DIR set kiye
// __resetMtfAutoForTests() chalate the — matlab REAL server/data ki
// LIVE book + Phase 0 config test-run me wipe ho jati thi.
//
// Fix: src/test/setup.ts har suite ke liye hermetic temp default deta
// hai. Ye test us contract ko pin karta hai:
//   1. env var vitest ke andar set hai aur server/data nahi hai
//   2. reset ke baad writes temp dir me jate hain
//   3. real server/data/mtf-auto-*.json ka mtime kabhi nahi badalta
//
// NOTE: ye file jaan-boojh kar apna MTF_AUTO_DATA_DIR set NAHI karti —
// yahi default-path regression ka point hai.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { __resetMtfAutoForTests } from '../server/ai/mtfAutoLink.js';

const PROJECT_ROOT = process.cwd();
const REAL_DATA = path.join(PROJECT_ROOT, 'server', 'data');
const REAL_CONFIG = path.join(REAL_DATA, 'mtf-auto-config.json');
const REAL_STATE = path.join(REAL_DATA, 'mtf-auto-state.json');

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

describe('v21.24.0 — MTF auto tests are hermetic by default', () => {
  it('setup.ts gives every suite a temp MTF_AUTO_DATA_DIR (never server/data)', () => {
    const dir = process.env.MTF_AUTO_DATA_DIR;
    expect(dir).toBeTruthy();
    const resolved = path.resolve(dir);
    expect(resolved.toLowerCase()).not.toBe(REAL_DATA.toLowerCase());
    // Must be outside the repo's production data folder.
    expect(resolved.toLowerCase().startsWith(REAL_DATA.toLowerCase())).toBe(false);
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it('__resetMtfAutoForTests writes only into the temp dir — production mtimes untouched', () => {
    const beforeCfg = mtimeMs(REAL_CONFIG);
    const beforeState = mtimeMs(REAL_STATE);

    __resetMtfAutoForTests({
      config: { enabled: true, liveEntryPaused: true },
      state: { book: [] },
    });

    const dir = path.resolve(process.env.MTF_AUTO_DATA_DIR);
    expect(fs.existsSync(path.join(dir, 'mtf-auto-config.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'mtf-auto-state.json'))).toBe(true);
    expect(mtimeMs(REAL_CONFIG)).toBe(beforeCfg);
    expect(mtimeMs(REAL_STATE)).toBe(beforeState);
  });
});
