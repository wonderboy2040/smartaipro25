// test/dataDirIsolation2127.test.ts — v21.27.1 PRO-LEVEL RECHECK LOCK
//
// Real defect found during the v21.27.0 hermetic smoke: mtfAutoLink and
// mtfRowLedgerStore only honored MTF_AUTO_DATA_DIR. A hermetic boot that
// isolates via SMARTAI_DATA_DIR (the documented dev/test convention) wrote
// the REAL server/data/mtf-auto-config.json + state + row ledger, and the
// smoke toggle disarmed live auto-trading (restored afterwards).
//
// optionsAutoEntry was worse: it hardcoded server/data AND its own suite
// set OPTIONS_AUTO_SCRATCH that the module never read (manual backup /
// restore of the live files around every run).
//
// This lock proves: with SMARTAI_DATA_DIR set, every write lands inside the
// sandbox and the real server/data files stay byte-identical (or stay absent).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DATA = path.join(APP_ROOT, 'server', 'data');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'smartai-isolation-'));
const REAL_FILES = [
  'mtf-auto-config.json',
  'mtf-auto-state.json',
  'mtf-row-ledger.json',
  'options-auto-config.json',
  'options-auto-state.json',
];

let realBefore: Record<string, { content: string } | null> = {};
let mtf: any;
let ledger: any;
let options: any;

const assertRealUntouched = () => {
  for (const name of REAL_FILES) {
    const p = path.join(REAL_DATA, name);
    const before = realBefore[name];
    if (!before) {
      expect(fs.existsSync(p), `${name} must not be created in real server/data`).toBe(false);
      continue;
    }
    expect(fs.readFileSync(p, 'utf8'), `${name} must stay byte-identical`).toBe(before.content);
  }
};

beforeAll(async () => {
  process.env.SMARTAI_DATA_DIR = SANDBOX;
  delete process.env.MTF_AUTO_DATA_DIR;
  delete process.env.OPTIONS_AUTO_SCRATCH;
  realBefore = Object.fromEntries(
    REAL_FILES.map((name) => {
      const p = path.join(REAL_DATA, name);
      return [name, fs.existsSync(p) ? { content: fs.readFileSync(p, 'utf8') } : null];
    }),
  );
  mtf = await import('../server/ai/mtfAutoLink.js');
  ledger = await import('../server/ai/mtfRowLedgerStore.js');
  options = await import('../server/ai/optionsAutoEntry.js');
});

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('v21.27.1 SMARTAI_DATA_DIR isolation', () => {
  it('MTF auto config + state writes land in the sandbox, never real server/data', () => {
    mtf.setMtfAutoEnabled(true);
    expect(fs.existsSync(path.join(SANDBOX, 'mtf-auto-config.json'))).toBe(true);
    expect(fs.existsSync(path.join(SANDBOX, 'mtf-auto-state.json'))).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'mtf-auto-config.json'), 'utf8'));
    expect(cfg.enabled).toBe(true);
    assertRealUntouched();
  });

  it('MTF row ledger writes land in the sandbox, never real server/data', () => {
    ledger.__resetMtfRowLedgerStoreForTests();
    const ok = ledger.saveMtfRowLedger({ rows: [] }, { force: true });
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(SANDBOX, 'mtf-row-ledger.json'))).toBe(true);
    assertRealUntouched();
  });

  it('options auto config writes land in the sandbox without OPTIONS_AUTO_SCRATCH', () => {
    options.setOptionsAutoEnabled(true);
    expect(fs.existsSync(path.join(SANDBOX, 'options-auto-config.json'))).toBe(true);
    assertRealUntouched();
  });

  it('OPTIONS_AUTO_SCRATCH still wins over SMARTAI_DATA_DIR (existing test contract)', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smartai-opt-scratch-'));
    process.env.OPTIONS_AUTO_SCRATCH = scratch;
    try {
      options.setOptionsAutoEnabled(false);
      expect(fs.existsSync(path.join(scratch, 'options-auto-config.json'))).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(path.join(scratch, 'options-auto-config.json'), 'utf8'));
      expect(cfg.enabled).toBe(false);
    } finally {
      delete process.env.OPTIONS_AUTO_SCRATCH;
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('MTF_AUTO_DATA_DIR still wins over SMARTAI_DATA_DIR (explicit override contract)', () => {
    const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'smartai-mtf-explicit-'));
    process.env.MTF_AUTO_DATA_DIR = explicit;
    try {
      mtf.updateMtfAutoConfig({ minScore: 81 });
      expect(fs.existsSync(path.join(explicit, 'mtf-auto-config.json'))).toBe(true);
      expect(fs.existsSync(path.join(SANDBOX, 'mtf-auto-config.json'))).toBe(true);
      assertRealUntouched();
    } finally {
      delete process.env.MTF_AUTO_DATA_DIR;
      try { fs.rmSync(explicit, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
