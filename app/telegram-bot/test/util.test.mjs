import assert from 'node:assert/strict';
import test from 'node:test';
import {
  esc,
  htmlToPlain,
  istTime,
  money,
  redactSecrets,
  splitHtml,
  splitPlain,
} from '../lib/util.mjs';

const balanced = (chunk, tag) => {
  const open = (chunk.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g')) || []).length;
  const close = (chunk.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  return open === close;
};

test('esc escapes only the three Telegram HTML characters', () => {
  assert.equal(esc('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d "e"');
});

test('htmlToPlain strips Telegram markup and decodes entities', () => {
  const text = htmlToPlain('<b>Money</b> &lt;risk&gt; &amp; costs<br>next');
  assert.equal(text, 'Money <risk> & costs\nnext');
});

test('splitHtml closes and reopens formatting tags across chunks', () => {
  const html = `<b>${'A'.repeat(5000)}</b><pre>${'B'.repeat(5000)}</pre>`;
  const chunks = splitHtml(html, 3900);

  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(balanced(chunk, 'b'));
    assert.ok(balanced(chunk, 'pre'));
  }
  assert.equal(chunks.join('').replace(/<\/?[^>]+>/g, ''), 'A'.repeat(5000) + 'B'.repeat(5000));
});

test('splitHtml leaves short messages untouched', () => {
  const html = '<b>short</b>';
  assert.deepEqual(splitHtml(html), [html]);
});

test('splitPlain respects the limit and keeps every character', () => {
  const input = `${'x'.repeat(1000)}\n${'y'.repeat(1000)}`;
  const chunks = splitPlain(input, 800);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 800);
  assert.equal(chunks.join('').replace(/\n/g, ''), input.replace(/\n/g, ''));
});

test('money never invents a currency symbol', () => {
  assert.equal(money(1234.5, 'INR'), '₹1,234.50');
  assert.equal(money(-12.5, 'USDT', { signed: true }), '-12.50 USDT');
  assert.equal(money(3, 'USDC'), '3.00 $');
  assert.equal(money(null, 'INR'), '—');
});

test('istTime renders IST without depending on the host timezone', () => {
  const ts = Date.UTC(2026, 0, 1, 0, 0, 0); // 05:30 IST
  assert.equal(istTime(ts), '05:30 IST');
  assert.equal(istTime(ts, { withDate: true }), '01/01 05:30 IST');
});

test('redactSecrets masks tokens embedded in free-form error text', () => {
  const text = redactSecrets(
    'send failed for bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA '
    + 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz api_key=super-secret token=abc123 pin=9999',
  );
  assert.doesNotMatch(text, /123456789:AAAAAAAA/);
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(text, /super-secret/);
  assert.match(text, /\[redacted-token\]/);
  assert.match(text, /Bearer \[redacted\]/);
  assert.match(text, /api_key=\[redacted\]/);
});
