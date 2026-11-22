/* Etapa 1 de melhorias (pontos adiados da auditoria). Unitário: sem banco, rede ou Mercado Pago reais. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

class Erro extends Error { constructor(message, code = 400) { super(message); this.code = code; } }
/* Carrega um módulo de src/ num contexto isolado, com dependências e temporizadores trocados por dublês. */
function carregar(arquivo, deps, extras = {}) {
  const sandbox = { module: { exports: {} }, Buffer, Date, console: { log() {}, warn() {}, error() {} }, setImmediate,
    setInterval: () => ({ unref() {} }), ...extras,
    require: id => { if (id in deps) return deps[id]; if (id.startsWith('node:')) return require(id); throw Error('Dependência inesperada: ' + id); } };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', arquivo), 'utf8'), sandbox);
  return sandbox.module.exports;
}

/* ---------- Limites por IP: IPv6 agrupado por /64 e formas textuais equivalentes ---------- */
test('chaveIp: o mesmo cliente IPv6 (/64) ou IPv4 mapeado vira a mesma chave de limite', () => {
  const { chaveIp } = require('../src/http');
  assert.equal(chaveIp('203.0.113.9'), '203.0.113.9');
  for (const v of ['::ffff:203.0.113.9', '::FFFF:CB00:7109', '[::ffff:203.0.113.9]']) assert.equal(chaveIp(v), '203.0.113.9', v);
  const rede = '2001:db8:0:1::/64';
  for (const v of ['2001:db8:0:1::1', '2001:DB8:0:1:ffff:ffff:ffff:ffff', '2001:0db8:0000:0001:0:0:0:abcd', '2001:db8:0:1:1:2:1.2.3.4'])
    assert.equal(chaveIp(v), rede, v);
  assert.notEqual(chaveIp('2001:db8:0:2::1'), rede);                       // outra rede /64 continua separada
  assert.equal(chaveIp('fe80::1%eth0'), chaveIp('fe80::2'));
  assert.equal(chaveIp(undefined), '');
});

/* ---------- /api/estado: parte pública montada uma vez e descartada a cada escrita confirmada ---------- */
function rifasComDubles() {
  let ger = 0, consultas = 0, varreduras = 0, imagens = 0;
  const db = {
    all: async () => { consultas++; await new Promise(r => setImmediate(r)); return []; },
    get: async (sql) => {
      if (sql.includes("FROM settings")) { consultas++; return undefined; }
      return { n: 0 };
    },
  };
  const rifas = carregar('rifas.js', {
    './db': { db, sha: s => s, agora: () => 'agora', tx: f => f(), audit: async () => {}, notificar: async () => {}, novaSemente: () => ({}),
      liberar: async () => {}, liberarSeVencido: async () => {}, geracao: () => ger },
    './http': { Erro, RE: {}, txt: v => v, inteiro: v => v, foto: v => v, abrev: n => n, limite: () => {}, JPG: 'data:image/jpeg;base64,', WEBP: 'data:image/webp;base64,' },
    './mail': {}, './mercadopago': { configurado: () => true },
    './config': { TESTE: false, CS2INSPECT_EMBED_KEY: '' },
    './pedidos': { finalizarVencidos: async () => { varreduras++; } },
    './imagens': { chaveCampanha: id => 'campanha:' + id, CHAVE_BANNER: 'banner', legadoCampanha: () => async () => '', legadoBanner: async () => '',
      ler: async () => { imagens++; return { raw: Buffer.from([0xff, 0xd8]), tipo: 'image/jpeg' }; } },
  });
  return { rifas, escrever: () => ger++, consultas: () => consultas, varreduras: () => varreduras, imagens: () => imagens };
}
test('estado: visitantes seguidos reaproveitam a parte pública até a próxima escrita', async () => {
  const t = rifasComDubles(), estado = t.rifas.rotas.find(r => r[1].test('/api/estado'))[2];
  await estado({ user: null });
  const porMontagem = t.consultas();
  assert.ok(porMontagem >= 4);
  await Promise.all(Array.from({ length: 20 }, () => estado({ user: null })));   // antes: 20 x as consultas
  assert.equal(t.consultas(), porMontagem);
  t.escrever();                                                                     // um pedido, ticket ou edição foi confirmado
  await estado({ user: null });
  assert.equal(t.consultas(), 2 * porMontagem);
  assert.equal(t.varreduras(), 1);                                                  // a varredura Pix não dispara a cada acesso
});
test('estado: requisições simultâneas com o cache vazio montam a parte pública uma vez só', async () => {
  const t = rifasComDubles(), estado = t.rifas.rotas.find(r => r[1].test('/api/estado'))[2];
  await Promise.all(Array.from({ length: 10 }, () => estado({ user: null })));
  const unica = t.consultas();
  t.escrever(); await estado({ user: null });
  assert.equal(t.consultas(), 2 * unica);
});
test('fotos públicas: decodificadas uma vez; escrita administrativa limpa o cache', async () => {
  const t = rifasComDubles(), foto = t.rifas.rotas.find(r => r[1].test('/api/campanhas/3/foto'))[2];
  for (let i = 0; i < 5; i++) assert.equal((await foto({ params: ['3'] })).tipo, 'image/jpeg');
  assert.equal(t.imagens(), 1);
  t.rifas.limparCacheImagens();
  await foto({ params: ['3'] });
  assert.equal(t.imagens(), 2);
});

/* ---------- criar-admin: carregar o módulo de pedidos não liga a varredura Pix ---------- */
test('pedidos: a varredura Pix só liga quando o servidor chama iniciarVarredura()', () => {
  const timers = [];
  const ped = carregar('pedidos.js', {
    './config': {}, './mercadopago': { configurado: () => true }, './mail': {},
    './db': { db: {}, sha: s => s, agora: () => '', tx: f => f(), audit: async () => {}, notificar: async () => {}, liberar: async () => {}, liberarSeVencido: async () => {} },
    './http': { Erro, inteiro: v => v, limite: () => {}, chaveIp: s => s },
  }, { setInterval: (fn, ms) => { timers.push(ms); return { unref() { return this; } }; } });
  assert.deepEqual(timers, []);                       // antes: armada no require, inclusive no "criar-admin"
  ped.iniciarVarredura(); ped.iniciarVarredura();
  assert.deepEqual(timers, [5000]);
});

/* ---------- Retenção: só eventos de rotina saem ---------- */
test('retenção da auditoria: pagamentos, sorteios e ações de administração nunca entram na limpeza', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/db.js'), 'utf8');
  const rotina = vm.runInNewContext(src.slice(src.indexOf('const AUDITORIA_ROTINA ='), src.indexOf('async function podarAuditoria')) + ';AUDITORIA_ROTINA');
  for (const a of rotina) assert.doesNotMatch(a, /PAGAMENTO|PEDIDO|PIX|SORTEIO|PREMIO|NUMEROS|USUARIO|ADMIN|CONTA|SENHA_(ALTERADA|REDEFINIDA)|MFA_BLOQUEADO/, a);
  assert.ok(rotina.includes('LOGIN_FALHA') && rotina.includes('WEBHOOK_REJEITADO'));
});
