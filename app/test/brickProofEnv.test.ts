import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(__dirname, '..', 'server', 'index.js'), 'utf8');

// v18.8.1 BRICK-PROOF ENV VALIDATION
// User hit exactly this on a portable install: TG_CHAT_ID added to .env,
// TG_TOKEN value lost → validateEnv() pushed a fatal error → "Refusing
// to start due to configuration errors" → the WHOLE trading app (desks,
// board, manual tracker, auto-trader) dead over an OPTIONAL notification
// channel. These contracts pin the new behavior: the half-pair is
// normalized at the TG definition site (BEFORE any subsystem arms) and
// can never reach the fatal path again.
describe('v18.8.1 brick-proof boot: TG half-config can never kill the server', () => {
  it('normalizes the half-set TG pair at the SOURCE (before any subsystem arms)', () => {
    // The normalization block exists and is anchored right at the TG const.
    expect(indexSource).toMatch(/v18\.8\.1 BRICK-PROOF TELEGRAM CONFIG/);
    const tgDef = indexSource.indexOf("const TG = {");
    const normBlock = indexSource.indexOf('v18.8.1 BRICK-PROOF TELEGRAM CONFIG');
    expect(tgDef).toBeGreaterThan(-1);
    expect(normBlock).toBeGreaterThan(tgDef);
    // Arm-time ordering: normalization runs at module scope, long before
    // validateEnv() is invoked near the end of the file.
    const validateCall = indexSource.indexOf('validateEnv();');
    expect(normBlock).toBeLessThan(validateCall);
  });

  it('clears BOTH sides of the pair AND the process.env fallbacks (webhook.js / bot child see the same clean state)', () => {
    expect(indexSource).toMatch(/TG\.token = '';/);
    expect(indexSource).toMatch(/TG\.chatId = '';/);
    expect(indexSource).toMatch(/process\.env\.TG_TOKEN = '';/);
    expect(indexSource).toMatch(/process\.env\.TG_CHAT_ID = '';/);
  });

  it('demotes the failure to a LOUD warning (not a silent swallow) with an actionable Hinglish fix', () => {
    const m = indexSource.match(/console\.warn\(\s*'\[wealth-ai\] WARNING: TG_TOKEN and TG_CHAT_ID must BOTH be set TOGETHER '/);
    expect(m).not.toBeNull();
    // The warning names the exact half it found (set/EMPTY per side).
    expect(indexSource).toMatch(/found TG_TOKEN=\$\{TG\.token \? 'set' : 'EMPTY'\}/);
  });

  it('REMOVED the old fatal: the TG mismatch error-push and its exit path are gone', () => {
    // The exact old fatal strings must not survive anywhere in the source.
    expect(indexSource).not.toMatch(/must both be set \(or both empty\)/);
    expect(indexSource).not.toMatch(/errors\.push\(\s*`TG_TOKEN and TG_CHAT_ID/);
  });

  it('auth-critical fatals stay FATAL (APP_PIN missing still refuses to start)', () => {
    expect(indexSource).toMatch(/APP_PIN is not set/);
    expect(indexSource).toMatch(/Refusing to start due to configuration errors\./);
    expect(indexSource).toMatch(/process\.exit\(1\)/);
  });

  it('the VITE_API_TOKEN===API_TOKEN bundle-leak fatal stays FATAL (deep-recheck H-1 intact)', () => {
    expect(indexSource).toMatch(/VITE_API_TOKEN === API_TOKEN/);
  });

  it('telegram senders keep gating on token+chatId TOGETHER (half-config sends were already impossible)', () => {
    // The /api/telegram relay gate.
    expect(indexSource).toMatch(/if \(!TG\.token \|\| !TG\.chatId\) return jsonError\(res, 503, 'telegram not configured on server'\)/);
    // The bot fork gate.
    expect(indexSource).toMatch(/if \(!TG\.token\) \{/);
  });
});
