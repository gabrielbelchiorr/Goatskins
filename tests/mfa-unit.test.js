/* Offline cryptographic compatibility checks. No provider or database connection. */
require('./helpers/ambiente-teste');
process.env.MFA_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('hex');
require('./helpers/pg-falso');
const test = require('node:test'), assert = require('node:assert/strict');
const mfa = require('../src/mfa');
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('MFA: RFC 6238 SHA-1 vectors, including timestamps beyond 32 bits', () => {
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'],
    [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'],
    [20000000000, '65353130']]) {
    assert.equal(mfa.totp(SECRET, Math.floor(seconds / 30), 8), expected);
    assert.equal(mfa.totp(SECRET, Math.floor(seconds / 30)), expected.slice(-6));
  }
});

test('MFA: RFC 4226 dynamic truncation and leading zeroes', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, step) => assert.equal(mfa.totp(SECRET, step), code));
  assert.equal(mfa.totp(SECRET, 1111111109 / 30 | 0, 8), '07081804');
});

test('MFA: base32 follows RFC 4648 without padding and preserves entropy', () => {
  for (const [input, expected] of [['', ''], ['f', 'MY'], ['fo', 'MZXQ'],
    ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.equal(mfa.base32(Buffer.from(input)), expected);
  }
  assert.equal(mfa.base32(Buffer.from('12345678901234567890')), SECRET);
});

test('MFA: verification accepts only the configured clock window and a newer step', () => {
  const step = 90001, now = step * 30000 + 12500;
  for (const delta of [-1, 0, 1]) {
    const code = mfa.totp(SECRET, step + delta);
    assert.equal(mfa.check(SECRET, code, -1, now), step + delta);
    assert.equal(mfa.check(SECRET, code, step + delta, now), -1);
    assert.equal(mfa.check(SECRET, code, step + delta + 1, now), -1);
  }
  for (const delta of [-3, -2, 2, 3]) assert.equal(mfa.check(SECRET, mfa.totp(SECRET, step + delta), -1, now), -1);
});

test('MFA: malformed codes are rejected without coercing arrays or objects', () => {
  for (const invalid of [null, undefined, true, 123456, [], {}, ['123456'],
    '', '12345', '1234567', '12 3456', '+12345', '１２３４５６', '\n123456', '123456\n']) {
    assert.equal(mfa.check(SECRET, invalid, -1, 2700042500), -1);
  }
});

test('MFA: a code accepted from the future window cannot be reused after the clock catches up', () => {
  const step = 120000, code = mfa.totp(SECRET, step + 1);
  const accepted = mfa.check(SECRET, code, -1, step * 30000);
  assert.equal(accepted, step + 1);
  assert.equal(mfa.check(SECRET, code, accepted, (step + 1) * 30000), -1);
  assert.equal(mfa.check(SECRET, mfa.totp(SECRET, step), accepted, step * 30000), -1);
});

test('MFA: AES-GCM encryption uses a fresh nonce and binds the secret to its administrator', () => {
  const first = mfa.encrypt(SECRET, 71), second = mfa.encrypt(SECRET, 71);
  assert.notEqual(first, second);
  assert.ok(!first.includes(SECRET));
  assert.equal(mfa.decrypt(first, 71), SECRET);
  assert.equal(mfa.decrypt(second, 71), SECRET);
  assert.throws(() => mfa.decrypt(first, 72));
  assert.throws(() => mfa.decrypt(first, undefined));
});

test('MFA: authenticated encryption rejects corruption instead of yielding another seed', () => {
  const encrypted = mfa.encrypt(SECRET, 71), parts = encrypted.split('.');
  // Current encoding has an IV, authentication tag and ciphertext. Mutate each actual byte field.
  for (let i = 0; i < parts.length; i++) {
    const bytes = Buffer.from(parts[i], 'base64');
    if (!bytes.length) continue;
    bytes[0] ^= 1;
    const changed = [...parts]; changed[i] = bytes.toString('base64');
    assert.throws(() => mfa.decrypt(changed.join('.'), 71));
  }
  for (const invalid of ['', 'garbage', 'a.b', 'a.b.c.d']) assert.throws(() => mfa.decrypt(invalid, 71));
});
