// ============================================================
// test/settings.test.ts — server-side app settings (v6.1)
// Covers: set/get round-trip + disk persistence, strict per-key
// validation (range / type / unknown keys), clear semantics,
// numeric-string coercion, the durable push wiring (encrypted
// envelope, no plaintext leak), and the coindcx manual-basis file
// shape migration ({ basis, updatedAt } with legacy-flat read).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// v20.3: hermetic — the settings/durable/portfolioSync suites used to
// read/write the DEV's live server/data directly (the exact pollution
// that shipped inside the v20.2 zip). Ride the shared temp dir the test
// setup assigns (SMARTAI_DATA_DIR) so the module and the test agree.
const DATA = process.env.SMARTAI_DATA_DIR || path.join(__dirname, '..', 'server', 'data');
const SETTINGS_PATH = path.join(DATA, 'mcp-settings.json');
const BASIS_PATH = path.join(DATA, 'mcp-coindcx-basis.json');

// ---- mock the GitHub backup layer BEFORE durable.js loads ----
const pushMock = vi.fn();
vi.mock('../server/lib/backup.js', () => ({
  scheduleBackup: (...args) => pushMock(...args),
  restoreBackup: async () => null,
  backupConfigured: () => !!(process.env.GITHUB_BACKUP_TOKEN && process.env.GITHUB_BACKUP_REPO),
}));

const settings = await import('../server/mcp/settings.js');
const { getSettings, setSetting } = settings;
const durable = await import('../server/mcp/durable.js');

function setDurableEnv() {
  process.env.GITHUB_BACKUP_TOKEN = 'ghp_testtoken';
  process.env.GITHUB_BACKUP_REPO = 'someone/smartai1';
  process.env.DURABLE_KEY = 'test-durable-key-16ch';
}

beforeEach(() => {
  setDurableEnv();
  durable.__resetDurableForTests();
  pushMock.mockClear();
  try { fs.rmSync(SETTINGS_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(BASIS_PATH, { force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  delete process.env.GITHUB_BACKUP_TOKEN;
  delete process.env.GITHUB_BACKUP_REPO;
  delete process.env.DURABLE_KEY;
  vi.clearAllMocks();
  try { fs.rmSync(SETTINGS_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(BASIS_PATH, { force: true }); } catch { /* ignore */ }
});

// ---------------- round-trip + persistence ----------------
describe('settings store', () => {
  it('set → get round-trips and persists to disk', () => {
    expect(getSettings()).toEqual({});
    const out = setSetting('usdAppRate', 92.0006);
    expect(out).toEqual({ usdAppRate: 92.0006 });
    expect(getSettings()).toEqual({ usdAppRate: 92.0006 });
    // File on disk has the envelope shape (value + updatedAt) — restart-safe.
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    expect(raw.settings.usdAppRate.value).toBe(92.0006);
    expect(raw.settings.usdAppRate.updatedAt).toBeGreaterThan(0);
    expect(raw.updatedAt).toBeGreaterThan(0);
  });

  it('accepts numeric strings (form-style input) and rounds to 6dp', () => {
    setSetting('usdAppRate', '88.1234567891');
    expect(getSettings().usdAppRate).toBeCloseTo(88.123457, 6);
  });

  it('null (or missing) value CLEARS the setting', () => {
    setSetting('usdAppRate', 92);
    setSetting('usdAppRate', null);
    expect(getSettings()).toEqual({});
    expect(fs.existsSync(SETTINGS_PATH)).toBe(true); // store file remains (empty)
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    expect(raw.settings.usdAppRate).toBeUndefined();
  });

  it('schedules an ENCRYPTED durable push on every write', () => {
    setSetting('usdAppRate', 92.0006);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [file, envelope] = pushMock.mock.calls[0];
    expect(file).toBe('mcp-settings.json');
    expect(envelope.alg).toBe('aes-256-gcm');
    // No plaintext rate in the pushed payload.
    expect(JSON.stringify(envelope)).not.toContain('92.0006');
    expect(durable.decryptJSON(envelope)).toMatchObject({
      settings: { usdAppRate: { value: 92.0006 } },
    });
  });
});

// ---------------- validation ----------------
describe('settings validation', () => {
  it.each([50, 150, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', {}])(
    'rejects out-of-range / non-numeric usdAppRate (%p) with a 400',
    (bad) => {
      expect(() => setSetting('usdAppRate', bad as unknown as number)).toThrowError();
      try {
        setSetting('usdAppRate', bad as unknown as number);
      } catch (e: any) {
        expect(e.status).toBe(400);
        expect(e.code).toBe('BAD_REQUEST');
      }
      // Nothing was persisted.
      expect(getSettings()).toEqual({});
    },
  );

  it('rejects unknown keys with a 400', () => {
    expect(() => setSetting('theme', 'dark')).toThrowError(/Unknown setting key/);
    try { setSetting('theme', 'dark'); } catch (e: any) {
      expect(e.status).toBe(400);
      expect(e.code).toBe('BAD_REQUEST');
    }
  });

  it('boundary values 50 < v < 150 are the valid window', () => {
    expect(() => setSetting('usdAppRate', 50.01)).not.toThrow();
    setSetting('usdAppRate', null);
    expect(() => setSetting('usdAppRate', 149.99)).not.toThrow();
    setSetting('usdAppRate', null);
  });
});

// ---------------- manual-basis file shape (coindcx) ----------------
describe('coindcx manual-basis file shape (v6.1)', () => {
  it('writes { basis, updatedAt } but keeps the flat-map API', async () => {
    const { setManualBasis, getManualBasis } = await import('../server/mcp/coindcx.js');
    setManualBasis('btc', 5259.07);
    expect(getManualBasis()).toEqual({ BTC: 5259.07 });
    const raw = JSON.parse(fs.readFileSync(BASIS_PATH, 'utf8'));
    expect(raw.basis).toEqual({ BTC: 5259.07 });
    expect(raw.updatedAt).toBeGreaterThan(0);
    // Durable push carries the WRAPPED store (fresh timestamps for restore).
    const pushed = pushMock.mock.calls.find((c) => c[0] === 'mcp-coindcx-basis.json');
    expect(pushed).toBeTruthy();
    expect(durable.decryptJSON(pushed![1])).toMatchObject({ basis: { BTC: 5259.07 } });
  });

  it('reads LEGACY flat files/backups (<= v6.0) as the basis map', async () => {
    fs.writeFileSync(BASIS_PATH, JSON.stringify({ BTC: 1234.5, ETH: 99 }));
    const { getManualBasis } = await import('../server/mcp/coindcx.js');
    expect(getManualBasis()).toEqual({ BTC: 1234.5, ETH: 99 });
  });
});
