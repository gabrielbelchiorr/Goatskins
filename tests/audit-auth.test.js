/* Controlled auth regressions: offline doubles and an opt-in disposable local PostgreSQL. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const schema = 'audit_auth_' + crypto.randomBytes(12).toString('hex');

class Erro extends Error {
  constructor(message, code = 400) { super(message); this.code = code; }
}
function offline({ get = async () => undefined, run = async () => ({ changes: 1 }), mail = {} } = {}) {
  let kdfCalls = 0;
  const mocks = {
    'node:crypto': { ...crypto, scrypt: (...args) => { kdfCalls++; crypto.scrypt(...args); } },
    './registration': { limiteEnvio: async () => {} },
    './config': { APP_URL: 'http://localhost' },
    './mail': mail,
    './db': { db: { get, run }, sha: s => crypto.createHash('sha256').update(s).digest('hex'),
      tx: fn => fn(), agora: () => new Date().toISOString(), audit: async () => {} },
    './http': { Erro, limite: () => {}, RE: { email: /^[^@]+@[^@]+\.[^@]+$/ } }
  };
  const sandbox = { module: { exports: {} }, Buffer, Date, console,
    setInterval: () => ({ unref() {} }), require: name => {
      assert.ok(name in mocks, 'Unexpected import: ' + name); return mocks[name];
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/auth.js'), 'utf8'), sandbox);
  return { route: pathname => sandbox.module.exports.rotas.find(r => r[1].test(pathname))[2],
    kdfCalls: () => kdfCalls };
}

test('reset rejects malformed, unknown and expired capabilities before password hashing', async () => {
  for (const token of [undefined, {}, 'invalid', 'f'.repeat(64)]) {
    let reads = 0;
    const h = offline({ get: async () => { reads++; return undefined; } });
    await assert.rejects(h.route('/api/redefinir-senha')({
      body: { token, senha: 'FixtureSenha123' }, ip: '127.0.0.1'
    }), e => /inválido ou expirado/.test(e.message));
    assert.equal(h.kdfCalls(), 0, 'An invalid reset capability must not consume scrypt work');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) assert.equal(reads, 0);
    else assert.equal(reads, 1);
  }
});

let store, auth, pool, mail, originalSend;
const fixtures = [];
before(async () => {
  if (!url) return;
  require('./helpers/ambiente-teste');
  const Pool = require('pg').Pool, setup = new Pool({ connectionString: url });
  try { await setup.query('CREATE SCHEMA ' + schema); } finally { await setup.end(); }
  const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema);
  Object.assign(process.env, { DATABASE_URL: scoped.toString(), TESTE: '1' });
  store = require('../src/db');
  mail = require('../src/mail'); originalSend = mail.enviar;
  mail.enviar = async () => ({ simulado: true });
  auth = require('../src/auth');
  pool = new Pool({ connectionString: scoped.toString(), statement_timeout: 10000 });
  await store.iniciar();
});
after(async () => {
  if (!store) return;
  // Delete only fixtures created by this file. Other suites share this disposable database.
  for (const id of fixtures) await store.db.run('DELETE FROM users WHERE id=?', [id]);
  mail.enviar = originalSend;
  await pool.end(); await store.fechar();
});
const pgOptions = { skip: !url, timeout: 15000 };
async function account() {
  const email = 'audit-auth-' + crypto.randomBytes(12).toString('hex') + '@goatskins.test';
  const hash = await auth.hashSenha('FixtureSenha123');
  const id = await store.db.insert('INSERT INTO users(nome,contato,email,hash,email_verificado) VALUES(?,?,?,?,1)',
    ['Audit auth fixture', email, email, hash]);
  fixtures.push(id); return { id, email, hash };
}
function context() {
  const headers = new Map();
  return { headers, req: { headers: {} }, res: { setHeader: (name, value) => headers.set(name, value) } };
}

test('real PostgreSQL: session opening cannot overtake an uncommitted password reset', pgOptions, async t => {
  const u = await account(), ctx = context(), client = await pool.connect();
  let outcome, request;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727401)');
    await client.query('UPDATE users SET hash=$1 WHERE id=$2', ['reset-fixture-hash', u.id]);
    await client.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
    // This is the opening performed by /conta/senha after its own password transaction.
    // Under MVCC an unlocked INSERT SELECT sees the old hash until this reset commits.
    request = auth.abrirSessao(ctx, u.id, u.hash).then(
      () => { outcome = { opened: true }; },
      error => { outcome = { opened: false, code: error.code }; }
    );
    let lockObserved = false;
    for (let i = 0; i < 100 && !outcome; i++) {
      const waiting = await client.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=727401 AND NOT granted LIMIT 1");
      if (waiting.rowCount) { lockObserved = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(outcome || lockObserved, 'The concurrent opening must finish or wait on the shared transaction lock');
    await client.query('COMMIT');
    await request;
    const remaining = (await store.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id=?', [u.id])).n;
    t.diagnostic('sessions surviving the concurrent reset: ' + remaining);
    assert.deepEqual(outcome, { opened: false, code: 401 });
    assert.equal(ctx.headers.has('Set-Cookie'), false);
    assert.equal(remaining, 0);
  } finally {
    await client.query('ROLLBACK'); client.release();
    if (request) await request;
  }
});

test('real PostgreSQL: a completed reset between password change and session opening rejects the old hash', pgOptions, async () => {
  const u = await account(), ctx = context();
  await store.tx(async () => {
    await store.db.run('UPDATE users SET hash=? WHERE id=?', ['another-fixture-hash', u.id]);
    await store.db.run('DELETE FROM sessions WHERE user_id=?', [u.id]);
  });
  await assert.rejects(auth.abrirSessao(ctx, u.id, u.hash), e => e.code === 401);
  assert.equal(ctx.headers.has('Set-Cookie'), false);
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id=?', [u.id])).n, 0);
});

test('real PostgreSQL: concurrent reset token use changes the password once and revokes existing sessions', pgOptions, async () => {
  const u = await account(), ctx = context(), token = crypto.randomBytes(32).toString('hex');
  await auth.abrirSessao(ctx, u.id, u.hash);
  await store.db.run("INSERT INTO tokens_email(token_hash,user_id,tipo,expira) VALUES(?,?,'REDEFINIR',?)",
    [store.sha(token), u.id, Date.now() + 60000]);
  const route = auth.rotas.find(r => r[1].test('/api/redefinir-senha'))[2];
  const results = await Promise.allSettled(['NewFixture123', 'OtherFixture456'].map(senha =>
    route({ body: { token, senha }, ip: '127.0.0.1' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 400).length, 1);
  const updated = await store.db.get('SELECT hash FROM users WHERE id=?', [u.id]);
  assert.notEqual(updated.hash, u.hash);
  const verified = await Promise.all(['NewFixture123', 'OtherFixture456'].map(senha => auth.confere(senha, updated.hash)));
  assert.equal(verified.filter(Boolean).length, 1);
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id=?', [u.id])).n, 0);
  assert.equal((await store.db.get("SELECT COUNT(*) n FROM tokens_email WHERE user_id=? AND tipo='REDEFINIR'", [u.id])).n, 0);
});

test('real PostgreSQL: expired reset tokens preserve the password, sessions and unused token state', pgOptions, async () => {
  const u = await account(), ctx = context(), token = crypto.randomBytes(32).toString('hex');
  await auth.abrirSessao(ctx, u.id, u.hash);
  await store.db.run("INSERT INTO tokens_email(token_hash,user_id,tipo,expira) VALUES(?,?,'REDEFINIR',?)",
    [store.sha(token), u.id, Date.now() - 1000]);
  const route = auth.rotas.find(r => r[1].test('/api/redefinir-senha'))[2];
  await assert.rejects(route({ body: { token, senha: 'NewFixture123' }, ip: '127.0.0.1' }), e => e.code === 400);
  assert.equal((await store.db.get('SELECT hash FROM users WHERE id=?', [u.id])).hash, u.hash);
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id=?', [u.id])).n, 1);
  assert.equal((await store.db.get('SELECT usado FROM tokens_email WHERE token_hash=?', [store.sha(token)])).usado, 0);
});
