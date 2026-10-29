import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, parseDotenv } from '../lib/config.mjs';

test('parseDotenv handles quotes, comments and export prefixes', () => {
  const parsed = parseDotenv([
    '# comment',
    'PLAIN=value',
    'SPACED = hello world ',
    'QUOTED="line\\nnext"',
    "SINGLE='kept as is'",
    'export EXPORTED=yes',
    'TRAILING=yes # inline comment',
    'EMPTY=',
  ].join('\n'));

  assert.equal(parsed.PLAIN, 'value');
  assert.equal(parsed.SPACED, 'hello world');
  assert.equal(parsed.QUOTED, 'line\nnext');
  assert.equal(parsed.SINGLE, 'kept as is');
  assert.equal(parsed.EXPORTED, 'yes');
  assert.equal(parsed.TRAILING, 'yes');
  assert.equal(parsed.EMPTY, '');
});

test('loadConfig accepts a complete owner-only configuration', () => {
  const cfg = loadConfig({
    TG_TOKEN: '123:abc',
    TG_CHAT_ID: '111, 222',
    API_TOKEN: 'service-token',
    PORT: '9090',
  });

  assert.equal(cfg.token, '123:abc');
  assert.deepEqual(cfg.ownerIds, ['111', '222']);
  assert.equal(cfg.apiToken, 'service-token');
  assert.equal(cfg.apiBaseUrl, 'http://127.0.0.1:9090');
  assert.equal(cfg.fatal, false);
  assert.deepEqual(cfg.problems, []);
});

test('loadConfig fails closed when Telegram credentials are missing', () => {
  const cfg = loadConfig({ API_TOKEN: 'x' });
  assert.equal(cfg.fatal, true);
  assert.ok(cfg.problems.some((p) => p.includes('TG_TOKEN')));
  assert.ok(cfg.problems.some((p) => p.includes('TG_CHAT_ID')));
});

test('loadConfig honours an explicit API base URL and clamps timeouts', () => {
  const cfg = loadConfig({
    TG_TOKEN: 't',
    TG_CHAT_ID: '1',
    API_TOKEN: 'x',
    BOT_API_BASE_URL: 'http://127.0.0.1:8080/',
    BOT_POLL_TIMEOUT_SEC: '999',
    BOT_CONFIRM_TTL_MS: '1',
  });

  assert.equal(cfg.apiBaseUrl, 'http://127.0.0.1:8080');
  assert.equal(cfg.pollTimeoutSec, 50);
  assert.equal(cfg.confirmTtlMs, 15000);
});
