const { test } = require('node:test'), assert = require('node:assert/strict');
const { bancoTeste } = require('../scripts/banco-teste');
test('all destructive test entry points require the same isolated local database', () => {
  for (const raw of ['not-a-url', 'postgresql://u:p@prod.example/goatskins_test',
    'postgresql://u:p@localhost/contest', 'postgresql://u:p@localhost/goatskins',
    'postgresql://u:p@localhost/goatskins_test?host=prod.example',
    'postgresql://u:p@localhost/goatskins_test#fragment', 'https://localhost/goatskins_test']) {
    assert.throws(() => bancoTeste(raw), e => /descartável/.test(e.message) && !e.message.includes(raw));
  }
  assert.equal(bancoTeste(''), '');
  assert.throws(() => bancoTeste('', true), /obrigatório/);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const raw = 'postgresql://fixture:fixture@' + host + ':55439/goatskins_test';
    assert.equal(bancoTeste(raw), raw);
  }
});
