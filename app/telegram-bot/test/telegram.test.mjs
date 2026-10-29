import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramClient, TelegramError } from '../lib/telegram.mjs';

const okResponse = (result) => new Response(JSON.stringify({ ok: true, result }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

test('send splits long HTML into multiple parse-safe messages', async () => {
  const payloads = [];
  const tg = new TelegramClient({
    token: 'token',
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return okResponse({ message_id: payloads.length });
    },
  });

  const sent = await tg.send(123, `<b>${'x'.repeat(9000)}</b>`);
  assert.ok(payloads.length >= 3);
  assert.equal(sent.message_id, payloads.length);
  for (const payload of payloads) {
    assert.equal(payload.parse_mode, 'HTML');
    assert.ok(payload.text.length <= 4096);
    assert.equal((payload.text.match(/<b>/g) || []).length, (payload.text.match(/<\/b>/g) || []).length);
  }
});

test('a Telegram parse error falls back to plain text once', async () => {
  const payloads = [];
  let calls = 0;
  const tg = new TelegramClient({
    token: 'token',
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities: unsupported start tag",
        }), { status: 400 });
      }
      return okResponse({ message_id: 7 });
    },
  });

  await tg.send(123, '<b>broken');
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].parse_mode, 'HTML');
  assert.equal(payloads[1].parse_mode, undefined);
  assert.equal(payloads[1].text, 'broken');
});

test('Telegram errors never include the bot token', async () => {
  const token = '123456:secret-token-value';
  const tg = new TelegramClient({
    token,
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      error_code: 401,
      description: `Unauthorized for bot${token}`,
    }), { status: 401 }),
  });

  await assert.rejects(
    () => tg.getMe(),
    (error) => {
      assert.ok(error instanceof TelegramError);
      assert.doesNotMatch(error.message, /secret-token-value/);
      return true;
    },
  );
});

test('429 responses honour retry_after before retrying', async () => {
  let calls = 0;
  const tg = new TelegramClient({
    token: 'token',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry later',
          parameters: { retry_after: 0 },
        }), { status: 429 });
      }
      return okResponse({ id: 1 });
    },
  });

  const started = Date.now();
  const me = await tg.getMe();
  assert.deepEqual(me, { id: 1 });
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1500);
});
