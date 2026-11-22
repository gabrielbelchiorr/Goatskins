/* Regressões das correções da auditoria de segurança (goatskins-run-1).
   Unitário: sem banco, rede, Turnstile ou Mercado Pago reais; dependências trocadas por dublês. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');

class Erro extends Error { constructor(message, code = 400) { super(message); this.code = code; } }
function carregar(rel, deps) {
  const filename = path.join(__dirname, '..', rel), m = new Module(filename);
  m.filename = filename;
  m.require = id => {
    if (id in deps) return deps[id];
    if (id.startsWith('node:')) return require(id);
    throw Error('Dependência inesperada em ' + rel + ': ' + id);
  };
  m._compile(fs.readFileSync(filename, 'utf8'), filename);
  return m.exports;
}
/* Contador atômico como o do PostgreSQL (INSERT ... ON CONFLICT ... RETURNING), com um await no meio
   para que chamadas simultâneas realmente se intercalem. */
function limitesAtomicos() {
  const n = new Map();
  return {
    n,
    consumirLimite: async (chave, max) => {
      await new Promise(r => setImmediate(r));
      const atual = n.get(chave) || 0;
      if (atual >= max) { throw new Erro('Muitas tentativas. Aguarde alguns minutos.', 429); }
      n.set(chave, atual + 1); return atual + 1;
    }
  };
}
const originalFetch = global.fetch;
test.after(() => { global.fetch = originalFetch; });

/* ---------- Pista 1: redirecionamento www não reinterpreta o caminho como outro host ---------- */
test('www: caminho "//host" (de "/.//host") fica na origem canônica e não lança', () => {
  const sec = carregar('src/security.js', {
    './config': { PRODUCAO: true, APP_URL: 'https://goatskins.com.br' },
    './http': { Erro, ipDe: () => '127.0.0.1', chaveIp: s => String(s) }, './db': { db: {}, sha: s => s }, './registration': { consumirLimite: async () => 1 },
  });
  const req = (alvo) => ({ method: 'GET', headers: { host: 'www.goatskins.com.br' }, alvo });
  for (const alvo of ['/.//a:b', '/.//example.invalid/', '/%2e//a:b', '/..//x']) {
    const url = new URL(alvo, 'http://localhost');
    assert.equal(url.origin, 'http://localhost');
    const destino = sec.redirecionamentoWww(req(alvo), url);   // antes: TypeError (derrubava o processo) ou Location em outro site
    assert.equal(new URL(destino).origin, 'https://goatskins.com.br', alvo + ' -> ' + destino);
  }
  assert.equal(sec.redirecionamentoWww(req('/?sorteio=7'), new URL('/?sorteio=7', 'http://localhost')), 'https://goatskins.com.br/?sorteio=7');
});

/* ---------- Pistas 8 e 11: Turnstile no reenvio e contagem atômica no login ---------- */
function segurancaComTurnstile() {
  const lim = limitesAtomicos(), chamadas = [];
  global.fetch = async (_url, op) => {
    const corpo = JSON.parse(op.body); chamadas.push(corpo.response);
    return { ok: true, json: async () => ({ success: true, hostname: 'goatskins.com.br', action: corpo.response }) };
  };
  const sec = carregar('src/security.js', {
    './config': { PRODUCAO: true, TESTE: false, APP_URL: 'https://goatskins.com.br', TURNSTILE_SITE_KEY: 's', TURNSTILE_SECRET_KEY: 'k', TURNSTILE_HOSTNAMES: '' },
    './http': { Erro, ipDe: () => '198.18.0.9', chaveIp: s => String(s) }, './db': { db: { get: async () => null }, sha: s => s },
    './registration': { consumirLimite: lim.consumirLimite },
  });
  return { sec, chamadas };
}
test('login: 20 tentativas simultâneas do mesmo IP não pulam o Turnstile (no máximo 3 passam sem desafio)', async () => {
  const { sec } = segurancaComTurnstile();
  const rs = await Promise.allSettled(Array.from({ length: 20 }, () => sec.proteger({ method: 'POST', headers: {} }, {}, '/api/login')));
  const livres = rs.filter(r => r.status === 'fulfilled').length;
  assert.ok(livres <= 3, livres + ' passaram sem Turnstile');      // antes: até 30
  assert.ok(rs.filter(r => r.status === 'rejected').every(r => r.reason.tipo === 'TURNSTILE_REQUIRED'));
});
test('reenvio do código de cadastro exige Turnstile (ação "reenvio")', async () => {
  const { sec, chamadas } = segurancaComTurnstile();
  await assert.rejects(sec.proteger({ method: 'POST', headers: {} }, {}, '/api/reenviar-verificacao'), e => e.tipo === 'TURNSTILE_REQUIRED');
  const req = { method: 'POST', headers: {} };
  await sec.proteger(req, { turnstileToken: 'reenvio' }, '/api/reenviar-verificacao');
  assert.equal(req.turnstileVerificado, 'reenvio'); assert.deepEqual(chamadas, ['reenvio']);
});

/* ---------- Pista 5: limitador em memória não recusa todo cliente novo quando enche ---------- */
test('limitador em memória: cheio, descarta o balde menos usado em vez de responder 429 a clientes novos', () => {
  const http = carregar('src/http.js', { './config': { TESTE: false, TRUST_PROXY: false, TRUST_PROXY_HOPS: 1 } });
  for (let i = 0; i < http.MAX_BALDES; i++) http.limite('red:k' + i, 10, 3600000);
  assert.equal(http._baldes.size, http.MAX_BALDES);
  assert.doesNotThrow(() => http.limite('api:198.51.100.7', 300, 60000));    // antes: 429 "Serviço ocupado"
  assert.doesNotThrow(() => http.limite('pedido:1', 10, 600000));
  assert.equal(http._baldes.size, http.MAX_BALDES);
  assert.equal(http._baldes.has('red:k0'), false);                            // o mais antigo saiu
  for (let i = 0; i < 3; i++) http.limite('login:x', 3, 60000);               // o limite por chave continua valendo
  assert.throws(() => http.limite('login:x', 3, 60000), e => e.code === 429);
});

/* ---------- Pistas 6 e 12: login sem trancar o dono e sem revelar contas ---------- */
test('login: após 5 tentativas o e-mail exige Turnstile (não bloqueia), com a mesma resposta exista ou não a conta', async () => {
  const lim = limitesAtomicos(), verificados = [];
  let hashCerto = null;
  const usuarios = { 'dono@goatskins.test': () => ({ id: 7, status: 'ACTIVE', email: 'dono@goatskins.test', email_verificado: 1, role: 'USER', hash: hashCerto }) };
  const db = {
    get: async (sql, p) => {
      if (sql.startsWith('SELECT * FROM users')) return usuarios[p[0]] ? usuarios[p[0]]() : undefined;
      if (sql.includes('INSERT INTO sessions')) return { user_id: 7 };
      return undefined;
    },
    run: async () => ({ changes: 1 }),
  };
  const auth = carregar('src/auth.js', {
    './registration': { consumirLimite: lim.consumirLimite, iniciar: async () => ({}) },
    './config': { PRODUCAO: false, TESTE: false }, './mail': { enviar: async () => null },
    './db': { db, sha: s => 'h:' + s, agora: () => 'agora', tx: f => f(), audit: async () => {}, notificar: async () => {}, comAutorizacao: (_a, f) => f() },
    './http': { Erro, RE: { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }, txt: v => v, limite: () => {}, cookie: () => null, ipDe: () => '1.2.3.4', chaveIp: s => String(s) },
    './security': { verificar: async (token, acao) => { verificados.push(acao); if (token !== 'ok') { const e = new Erro('Conclua a verificação de segurança.', 403); e.tipo = 'TURNSTILE_REQUIRED'; throw e; } } },
  });
  hashCerto = await auth.hashSenha('Senha1234');
  const login = auth.rotas.find(r => r[1].test('/api/login'))[2];
  const chamar = (email, senha, extra = {}) => login({ ip: '1.2.3.4', body: { email, senha, ...extra }, req: { headers: {} }, res: { setHeader() {} } });
  const respostas = {};
  for (const email of ['dono@goatskins.test', 'naoexiste@goatskins.test']) {
    for (let i = 0; i < 5; i++) await assert.rejects(chamar(email, 'errada123'), e => e.code === 401 && e.message === 'E-mail ou senha incorretos.');
    // 6ª tentativa: desafio, nunca "Conta bloqueada" (429) só para contas reais
    respostas[email] = await chamar(email, 'errada123').catch(e => ({ code: e.code, tipo: e.tipo, msg: e.message }));
  }
  assert.deepEqual(respostas['dono@goatskins.test'], respostas['naoexiste@goatskins.test']);
  assert.equal(respostas['dono@goatskins.test'].tipo, 'TURNSTILE_REQUIRED');
  // O dono, com a senha certa e o desafio resolvido, entra mesmo depois das falhas de um terceiro.
  assert.deepEqual(await chamar('dono@goatskins.test', 'Senha1234', { turnstileToken: 'ok' }), { ok: true });
  assert.ok(verificados.every(a => a === 'login'));
});

/* ---------- Pista 10: HTML montado por requisição não é recomprimido a cada acesso ---------- */
test('estático: HEAD não comprime; GET repetido do mesmo corpo reaproveita a versão comprimida', async () => {
  let compressoes = 0;
  const zlib = require('node:zlib');
  const zlibContado = { ...zlib, brotliCompress: (b, o, cb) => { compressoes++; return zlib.brotliCompress(b, o, cb); } };
  const est = carregar('src/estatico.js', { 'node:zlib': zlibContado, './config': { APP_URL: 'https://goatskins.com.br', raiz: path.join(__dirname, '..') } });
  const publicos = new Set(['index.html', 'style.css']);
  const res = () => ({ cab: null, writeHead(c, h) { this.code = c; this.cab = h; }, end() {} });
  const req = method => ({ method, headers: { 'accept-encoding': 'br' } });
  const url = new URL('https://goatskins.com.br/robots.txt');
  const head = res(); await est.especial(req('HEAD'), head, '/robots.txt', url, publicos);
  assert.equal(head.code, 200); assert.equal(compressoes, 0);                 // antes: Brotli qualidade 11 só para descartar
  for (let i = 0; i < 5; i++) { const r = res(); await est.especial(req('GET'), r, '/robots.txt', url, publicos); assert.equal(r.cab['Content-Encoding'], 'br'); }
  assert.equal(compressoes, 1);                                               // antes: uma compressão por requisição
});
