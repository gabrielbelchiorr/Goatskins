/* Senhas novas previsíveis são recusadas; senhas fortes e aleatórias passam. */
const { test } = require('node:test'), assert = require('node:assert/strict');
const { senhaComum } = require('../src/senhas-comuns');
const fs = require('node:fs'), path = require('node:path');

test('senhas comuns: palavra conhecida + números, sequências, repetições e enfeites', () => {
  for (const s of ['senha123', 'Senha@2024', 'password1', 'goatskins1', '123mudar', 'Admin2025', 'abc12345', 'qwerty123',
    '1q2w3e4r', 'a1b2c3d4', '12345678a', 'a1234567', 'aaaa1111', 'ab12ab12', 'Flamengo10', 'iloveyou2'])
    assert.equal(senhaComum(s), true, s);
});

test('senhas comuns: recusa o próprio nome ou e-mail, ignorando acentos e maiúsculas', () => {
  assert.equal(senhaComum('Belchior2024', ['ggoatskins@gmail.com', 'Belchior']), true);
  assert.equal(senhaComum('joaosilva99', ['joao.silva@exemplo.com']), true);
  assert.equal(senhaComum('Joãozinho7x', ['joaozinho@exemplo.com']), true);
  assert.equal(senhaComum('Kx9mPq2vLt', ['Ana', 'ana@exemplo.com']), false, 'nomes curtos não bloqueiam tudo');
});

test('senhas comuns: senhas fortes passam', () => {
  for (const s of ['Kx9#mPq2vL', 'CavaloBateria7', 'ZebraAzul42', 'Fixa9Kp2x', 'OutraSenha77', 'tr0mb0ne-vermelho'])
    assert.equal(senhaComum(s), false, s);
  assert.equal(senhaComum(undefined), true);
});

test('CSP: estilos sem unsafe-inline e scripts só da própria origem e do Turnstile', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const csp = server.match(/"Content-Security-Policy", "([^"]+)"/)[1];
  assert.match(csp, /style-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'none'/);
});
