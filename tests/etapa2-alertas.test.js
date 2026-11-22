/* Etapa 2: alertas por e-mail para a administração e fila pós-commit. Unitário: sem banco nem e-mail reais. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function carregarAlertas(admins) {
  const enviados = [];
  const sandbox = { module: { exports: {} }, Date, console: { error() {} }, Promise,
    require: id => ({ './config': { APP_URL: 'https://goatskins.com.br' }, './mail': { enviar: async (para, assunto, texto) => { enviados.push({ para, assunto, texto }); } },
      './db': { db: { all: async () => admins.map(email => ({ email })) } } })[id] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/alertas.js'), 'utf8'), sandbox);
  return { alertas: sandbox.module.exports, enviados };
}
test('alertas: vão para todos os admins ativos, com o tipo e o detalhe, e sem eventos fora da lista', async () => {
  const { alertas, enviados } = carregarAlertas(['a@goatskins.test', 'b@goatskins.test']);
  assert.equal(await alertas.enviar('LOGIN_FALHA', 'x'), false);                       // rotina não vira e-mail
  assert.equal(await alertas.enviar('PAGAMENTO_TARDIO_REEMBOLSAR', 'pedido 9 pago após a reserva vencer'), true);
  assert.deepEqual(enviados.map(e => e.para), ['a@goatskins.test', 'b@goatskins.test']);
  assert.match(enviados[0].assunto, /^\[GOATSKINS\] .*reembolso/);
  assert.match(enviados[0].texto, /pedido 9/); assert.match(enviados[0].texto, /PAGAMENTO_TARDIO_REEMBOLSAR/);
});
test('alertas: no máximo um e-mail por tipo a cada 15 min; o seguinte conta os que ficaram de fora', async () => {
  const { alertas, enviados } = carregarAlertas(['a@goatskins.test']);
  const realNow = Date.now; let agora = 1e12; Date.now = () => agora;
  try {
    for (let i = 0; i < 5; i++) await alertas.enviar('PIX_CRIACAO_INCERTA', 'pedido ' + i);
    assert.equal(enviados.length, 1);
    await alertas.enviar('MFA_BLOQUEADO', 'outro tipo');                                // tipos diferentes não se bloqueiam
    assert.equal(enviados.length, 2);
    agora += alertas.INTERVALO_MS + 1;
    await alertas.enviar('PIX_CRIACAO_INCERTA', 'pedido 9');
    assert.equal(enviados.length, 3); assert.match(enviados[2].texto, /Mais 4 evento/);
  } finally { Date.now = realNow; }
});
test('alertas: a lista de ações com alerta em db.js é a mesma de alertas.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/db.js'), 'utf8');
  const doBanco = vm.runInNewContext(src.slice(src.indexOf('const ACOES_COM_ALERTA ='), src.indexOf('module.exports')) + ';[...ACOES_COM_ALERTA]');
  const { alertas } = carregarAlertas([]);
  assert.deepEqual([...doBanco].sort(), Object.keys(alertas.ALERTAS).sort());
});
