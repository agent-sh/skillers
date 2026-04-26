'use strict';

/**
 * Tests for lib/sanitize.js
 *
 * Run: node lib/sanitize.test.js
 * Asserts secrets are redacted and safe content is preserved.
 */

const assert = require('assert');
const { redact } = require('./sanitize');

function t(name, fn) {
  try { fn(); console.log(`[OK]   ${name}`); }
  catch (e) { console.error(`[FAIL] ${name}\n  ${e.message}`); process.exitCode = 1; }
}

t('redacts OpenAI sk- key', () => {
  const out = redact('key: sk-abcdefghijklmnopqrstuvwxyz1234');
  assert.ok(out.includes('[REDACTED_API_KEY]'), out);
  assert.ok(!out.includes('sk-abcdefghij'), out);
});

t('redacts Anthropic sk-ant key', () => {
  const out = redact('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv');
  assert.ok(out.includes('[REDACTED]'), out);
});

t('redacts GitHub ghp_ token', () => {
  const out = redact('ghp_1234567890abcdefghij1234567890abcdef12');
  assert.ok(out.includes('[REDACTED_TOKEN]'), out);
});

t('redacts AWS AKIA key', () => {
  const out = redact('AKIAIOSFODNN7EXAMPLE is the key');
  assert.ok(out.includes('[REDACTED_AWS_KEY]'), out);
});

t('redacts Bearer token', () => {
  const out = redact('Authorization: Bearer abcdefghijklmnopqrst1234');
  assert.ok(out.includes('Bearer [REDACTED]'), out);
});

t('preserves JWT (has eyJ prefix)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.abc123';
  const out = redact('token: ' + jwt);
  assert.ok(out.includes('eyJhbGc'), out);
});

t('preserves git SHA', () => {
  const out = redact('commit 1234567890abcdef1234567890abcdef12345678');
  assert.ok(out.includes('1234567890abcdef1234567890abcdef12345678'), out);
});

t('preserves file path', () => {
  const out = redact('/usr/local/share/something/with.a.long.path.txt');
  assert.ok(out.includes('/usr/local/share'), out);
});

t('high-entropy opaque string redacted', () => {
  const out = redact('token=' + 'aB3xQ9mR7tZ2vW5pL8sK4nY6cF1jH0gE');
  assert.ok(out.includes('[REDACTED_HIGH_ENTROPY]'), out);
});

t('plain English not redacted', () => {
  const text = 'The user wanted to check CI and open a PR';
  assert.strictEqual(redact(text), text);
});

t('accepts null / non-string gracefully', () => {
  assert.strictEqual(redact(null), null);
  assert.strictEqual(redact(42), '42');
});
