/* Synthetic values are constructed here; no production credentials are used. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanText, scanTracked, runtimeEnv } = require('../scripts/verificar-segredos');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-secret-fixture-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('secret heuristics identify supported synthetic formats and return no matching values', () => {
  const fixtures = [
    ['private-key', '-----' + 'BEGIN OPENSSH PRIVATE KEY' + '-----'],
    ['github-token', 'ghp_' + 'a1'.repeat(18)],
    ['resend-token', 're_' + 'aB7'.repeat(12)],
    ['mercadopago-token', 'APP_USR-' + '12ab-'.repeat(16)],
    ['assigned-hex-secret', 'MP_WEBHOOK_SECRET=' + 'af'.repeat(32)],
    ['assigned-hex-secret', 'MFA_ENCRYPTION_KEY=' + 'ba'.repeat(32)],
    ['assigned-hex-secret', '"TWILIO_AUTH_TOKEN": "' + 'a1'.repeat(16) + '"']
  ];
  for (const [rule, value] of fixtures) {
    const result = scanText('safe\n' + value);
    assert.deepEqual(result, [{ rule, line: 2 }]);
    assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.deepEqual(scanText('const secret = process.env.MP_WEBHOOK_SECRET;\nMP_WEBHOOK_SECRET=configure_no_painel'), []);
});

test('tests and example files receive the same secret checks as application files', () => {
  fs.mkdirSync(path.join(root, 'tests'));
  const token = 'ghp_' + 'b2'.repeat(18);
  fs.writeFileSync(path.join(root, 'tests', 'fixture.js'), 'const value="' + token + '";');
  fs.writeFileSync(path.join(root, '.env.example'), 'EMAIL_CODE_SECRET=' + 'ab'.repeat(32));
  const result = scanTracked(root, ['tests/fixture.js', '.env.example']);
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.findings, [
    { path: 'tests/fixture.js', rule: 'github-token', line: 1 },
    { path: '.env.example', rule: 'assigned-hex-secret', line: 1 }
  ]);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('runtime dotenv paths are rejected without opening them and without a test-directory exception', () => {
  for (const name of ['.env', '.env.production', 'tests/.env.test', 'nested/.env.local']) assert.equal(runtimeEnv(name), true);
  assert.equal(runtimeEnv('.env.example'), false);
  // The directory cannot be read as a file. Classification must happen first.
  fs.mkdirSync(path.join(root, '.env'));
  assert.deepEqual(scanTracked(root, ['.env', 'tests/.env.test']).findings, [
    { path: '.env', rule: 'tracked-runtime-env' },
    { path: 'tests/.env.test', rule: 'tracked-runtime-env' }
  ]);
});

test('binary, oversized, missing and unsafe paths are accounted for explicitly', () => {
  fs.writeFileSync(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1));
  const result = scanTracked(root, ['binary', 'large', 'missing', '../outside']);
  assert.equal(result.binary, 1); assert.equal(result.oversized, 1); assert.equal(result.deleted, 1);
  assert.deepEqual(result.findings, [{ path: '../outside', rule: 'outside-repository' }]);
});
