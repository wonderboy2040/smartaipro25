import assert from 'node:assert/strict';
import test from 'node:test';
import { marketFromArgs, parseCommand, resolveCommand } from '../lib/commands.mjs';
import { createRouter } from '../lib/router.mjs';

const owner = '123';

const status = () => ({
  ok: true,
  enabled: false,
  executionMode: 'live',
  openCount: 0,
  riskCaps: {
    effectiveRiskINR: 100,
    effectiveWalletDeployPct: 100,
    effectiveLeverage: 5,
  },
  effectiveWalletINR: 10000,
  maxTradesPerDay: 3,
  coindcxConnected: true,
  siteLiveActive: true,
  deskArmable: true,
  killSwitch: false,
  deepMonitor: { activeCount: 0, trades: [] },
});

function harness({ now = 1000 } = {}) {
  const calls = [];
  const tg = {
    sent: [],
    edits: [],
    answers: [],
    async send(chatId, text, options = {}) {
      this.sent.push({ chatId, text, ...options });
      return { message_id: 100 + this.sent.length };
    },
    async edit(chatId, messageId, text, options = {}) {
      this.edits.push({ chatId, messageId, text, ...options });
      return { message_id: messageId };
    },
    async answerCallback(id, text = '', options = {}) {
      this.answers.push({ id, text, ...options });
    },
    async typing() {},
  };
  const api = {
    invalidateAuto() {},
    async mtfAutoStatus() {
      return status();
    },
    async toggleAuto(enabled) {
      calls.push(['toggle', enabled]);
      return { ...status(), enabled };
    },
    async setAutoConfig(patch) {
      calls.push(['config', patch]);
      return { ok: true, config: patch };
    },
  };
  const config = {
    ownerIds: [owner],
    confirmTtlMs: 90000,
    maxAgentChars: 2000,
  };
  let clockNow = now;
  const router = createRouter({
    api,
    tg,
    config,
    clock: () => clockNow,
    botUsername: 'SmartAIProBot',
  });
  return {
    router,
    tg,
    calls,
    setNow: (value) => { clockNow = value; },
  };
}

const message = (text, from = owner) => ({
  message_id: 1,
  from: { id: Number(from) },
  chat: { id: Number(from), type: 'private' },
  text,
});

const callback = (data, messageId = 101) => ({
  id: 'cb-1',
  from: { id: Number(owner) },
  message: { message_id: messageId, chat: { id: Number(owner), type: 'private' } },
  data,
});

const confirmButton = (tg) => tg.sent[0]?.keyboard?.[0]?.[0];
const cancelButton = (tg) => tg.sent[0]?.keyboard?.[0]?.[1];

test('parseCommand accepts bot mentions and rejects a different bot', () => {
  assert.deepEqual(parseCommand('/status@SmartAIProBot now', 'smartaiproBot'), {
    name: 'status',
    args: 'now',
    mentioned: true,
  });
  assert.equal(parseCommand('/status@OtherBot', 'SmartAIProBot'), null);
  assert.equal(parseCommand('hello'), null);
});

test('resolveCommand maps aliases without changing real command names', () => {
  assert.deepEqual(resolveCommand('gold'), { name: 'signals', args: 'metals' });
  assert.deepEqual(resolveCommand('portfolio'), { name: 'positions', args: '' });
  assert.deepEqual(resolveCommand('status'), { name: 'status', args: '' });
});

test('marketFromArgs only accepts known desks via the handler', () => {
  assert.equal(marketFromArgs('metals'), 'METALS');
  assert.equal(marketFromArgs('us'), 'GLOBALFUTURES');
  assert.equal(marketFromArgs('unknown', 'CRYPTO'), 'CRYPTO');
});

test('unauthorized chats are ignored without calling the site API', async () => {
  const { router, tg, calls } = harness();
  await router.dispatchUpdate({ message: message('/auto on', '999') });

  assert.equal(calls.length, 0);
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /Private bot/);
  assert.equal(router.pendingCount(), 0);
});

test('/auto on asks for an inline confirmation instead of arming immediately', async () => {
  const { router, tg, calls } = harness();
  await router.dispatchUpdate({ message: message('/auto on') });

  assert.equal(calls.length, 0);
  assert.equal(router.pendingCount(), 1);
  assert.match(tg.sent[0].text, /ARM LIVE AUTO-TRADE/);

  const button = confirmButton(tg);
  assert.match(button.callback_data, /^c:auto:confirm:/);
  assert.match(cancelButton(tg).callback_data, /^c:auto:cancel:/);
});

test('tapping Confirm executes the pending action exactly once', async () => {
  const { router, tg, calls } = harness();
  await router.dispatchUpdate({ message: message('/auto on') });
  const data = confirmButton(tg).callback_data;

  await router.dispatchUpdate({ callback_query: callback(data) });
  assert.deepEqual(calls, [['toggle', true]]);
  assert.equal(router.pendingCount(), 0);
  assert.ok(tg.edits.some((e) => /LIVE AUTO ARMED/.test(e.text)));

  // A replay of the same callback must not execute again.
  await router.dispatchUpdate({ callback_query: callback(data) });
  assert.deepEqual(calls, [['toggle', true]]);
});

test('tapping Cancel never arms the engine', async () => {
  const { router, tg, calls } = harness();
  await router.dispatchUpdate({ message: message('/auto on') });
  const data = cancelButton(tg).callback_data;

  await router.dispatchUpdate({ callback_query: callback(data) });
  assert.equal(calls.length, 0);
  assert.equal(router.pendingCount(), 0);
  assert.ok(tg.edits.some((e) => /Cancelled/.test(e.text)));
});

test('expired confirmations never execute and are cleared', async () => {
  const { router, tg, calls, setNow } = harness({ now: 1000 });
  await router.dispatchUpdate({ message: message('/auto on') });
  const data = confirmButton(tg).callback_data;
  setNow(1000 + 90001);

  await router.dispatchUpdate({ callback_query: callback(data) });
  assert.equal(calls.length, 0);
  assert.equal(router.pendingCount(), 0);
  assert.ok(tg.answers.some((a) => /Expired/.test(a.text)));
  assert.ok(tg.edits.some((e) => /expire/.test(e.text)));
});

test('/cancel clears a pending confirmation', async () => {
  const { router, tg, calls } = harness();
  await router.dispatchUpdate({ message: message('/auto on') });
  await router.dispatchUpdate({ message: message('/cancel') });

  assert.equal(router.pendingCount(), 0);
  assert.equal(calls.length, 0);
  assert.ok(tg.sent.some((s) => /pending confirmation cancel/.test(s.text)));
});
