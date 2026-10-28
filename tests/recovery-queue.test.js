/* Real queue/storage regressions in a guarded disposable PostgreSQL schema. No provider/network. */
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const schema = 'recovery_queue_' + crypto.randomBytes(12).toString('hex');
const options = { skip: !url, timeout: 20000 };
let store, recovery, auth, cfg, mail, setup, originalRequired, originalSend;
const calls = [];
let send;

before(async () => {
  if (!url) return;
  // Override inherited real credentials before importing any application configuration.
  require('./helpers/ambiente-teste');
  setup = new (require('pg').Pool)({ connectionString: url });
  await setup.query('CREATE SCHEMA ' + schema);
  const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema);
  Object.assign(process.env, { DATABASE_URL: scoped.toString(), TESTE: '1' });
  store = require('../src/db'); await store.iniciar();
  cfg = require('../src/config'); mail = require('../src/mail'); auth = require('../src/auth');
  originalRequired = mail.enviarObrigatorio; originalSend = mail.enviar;
  mail.enviarObrigatorio = async (...args) => { calls.push(args); return send(...args); };
  mail.enviar = async () => ({ simulado: true });
  recovery = require('../src/recovery');
  await store.db.run('CREATE TABLE recovery_test_failures(kind TEXT PRIMARY KEY)');
  await store.db.run(`CREATE FUNCTION recovery_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF NEW.acao='SENHA_RECUPERACAO_PEDIDA' AND EXISTS(SELECT 1 FROM recovery_test_failures WHERE kind='audit')
    THEN RAISE EXCEPTION 'controlled recovery audit failure'; END IF; RETURN NEW; END $f$`);
  await store.db.run('CREATE TRIGGER recovery_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION recovery_fail_audit()');
  await store.db.run(`CREATE FUNCTION recovery_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF EXISTS(SELECT 1 FROM recovery_test_failures WHERE kind='commit')
    THEN RAISE EXCEPTION 'controlled recovery commit failure'; END IF; RETURN NEW; END $f$`);
  await store.db.run(`CREATE CONSTRAINT TRIGGER recovery_fail_commit AFTER INSERT ON password_recovery_jobs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recovery_fail_commit()`);
});
beforeEach(async () => {
  if (!store) return;
  calls.length = 0; send = async () => ({ simulado: true });
  // Only transient rows in this file's unique schema, never shared/public data.
  await store.db.run('DELETE FROM password_recovery_jobs');
  await store.db.run('DELETE FROM tokens_email');
  await store.db.run('DELETE FROM auth_rate_limits');
  await store.db.run('DELETE FROM recovery_test_failures');
});
afterEach(async () => { if (store) await store.db.run('DELETE FROM recovery_test_failures'); });
after(async () => {
  if (mail) { mail.enviarObrigatorio = originalRequired; mail.enviar = originalSend; }
  if (store) await store.fechar();
  if (setup) await setup.end();
});

async function account() {
  const email = 'recovery-' + crypto.randomBytes(12).toString('hex') + '@goatskins.test';
  const hash = await auth.hashSenha('FixtureRecovery123');
  const id = await store.db.insert('INSERT INTO users(nome,contato,email,hash,email_verificado) VALUES(?,?,?,?,1)',
    ['Recovery fixture', email, email, hash]);
  return { id, email, hash };
}
const handler = pathname => auth.rotas.find(r => r[0] === 'POST' && r[1].test(pathname))[2];
const ctx = u => ({ user: { id: u.id, role: 'USER' }, ip: '127.0.0.1', req: { headers: {} }, res: { setHeader() {} } });
async function enqueue(email) { await store.tx(() => recovery.enfileirar(email, '127.0.0.1')); }
const job = email => store.db.get('SELECT * FROM password_recovery_jobs WHERE email=?', [email]);
const count = table => store.db.get('SELECT COUNT(*) n FROM ' + table).then(row => row.n);
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled worker did not reach its send')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function due(email) { await store.db.run('UPDATE password_recovery_jobs SET proximo=0,lease_ate=0 WHERE email=?', [email]); }

test('queue PG: enqueue uses the same INSERT for present/absent accounts and stores no raw capability', options, async () => {
  const u = await account(), absent = 'absent-' + crypto.randomBytes(12).toString('hex') + '@goatskins.test';
  const queries = [], original = store.db.run;
  store.db.run = async (sql, params) => { queries.push(sql); return original(sql, params); };
  try { await enqueue(u.email); await enqueue(absent); } finally { store.db.run = original; }
  assert.equal(queries.length, 2); assert.equal(queries[0], queries[1]);
  assert.match(queries[0], /^INSERT INTO password_recovery_jobs/);
  const rows = await store.db.all('SELECT * FROM password_recovery_jobs ORDER BY email');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const raw = crypto.createHmac('sha256', cfg.EMAIL_CODE_SECRET).update('goatskins:password-recovery:v1:' + row.id).digest('hex');
    assert.equal(row.expira - row.criado_em, 3600000);
    assert.equal(row.token_hash, null); assert.equal(row.contexto, null);
    assert.equal(JSON.stringify(row).includes(raw), false);
  }
  assert.equal(calls.length, 0); assert.equal(await count('tokens_email'), 0);
});

test('queue PG: only committed jobs survive a module reload and can be processed after restart', options, async () => {
  const u = await account(); await enqueue(u.email);
  const persisted = await job(u.email);
  delete require.cache[require.resolve('../src/recovery')];
  const restarted = require('../src/recovery');
  assert.equal((await job(u.email)).id, persisted.id);
  const entered = deferred();
  send = async () => { entered.resolve(); return { simulado: true }; };
  const stop = restarted.iniciarProcessador();
  try { await bounded(entered.promise); } finally { await stop(); }
  assert.equal(calls.length, 1); assert.equal(await job(u.email), undefined);
  assert.equal(await count('tokens_email'), 1);
  assert.equal(await restarted.processarUma(), false);
});

test('queue PG: failed COMMIT rolls back both the durable job and persistent request limits', options, async () => {
  const email = 'rollback-' + crypto.randomBytes(12).toString('hex') + '@goatskins.test';
  await store.db.run("INSERT INTO recovery_test_failures VALUES('commit')");
  await assert.rejects(store.tx(async () => {
    await require('../src/registration').limiteEnvio(email, '127.0.0.1');
    await recovery.enfileirar(email, '127.0.0.1');
  }), /controlled recovery commit failure/);
  assert.equal(await count('password_recovery_jobs'), 0);
  assert.equal(await count('auth_rate_limits'), 0);
  assert.equal(calls.length, 0);
  await store.db.run('DELETE FROM recovery_test_failures');
  await store.tx(async () => { await require('../src/registration').limiteEnvio(email, '127.0.0.1'); await recovery.enfileirar(email, '127.0.0.1'); });
  assert.equal(await count('password_recovery_jobs'), 1);
  assert.equal((await store.db.get('SELECT n FROM auth_rate_limits WHERE chave=?', ['email:' + store.sha(email)])).n, 1);
});

test('queue PG: missing and inactive accounts are discarded without sending or creating tokens', options, async () => {
  const u = await account(); await store.db.run("UPDATE users SET status='SUSPENDED' WHERE id=?", [u.id]);
  for (const email of [u.email, 'missing-' + crypto.randomBytes(12).toString('hex') + '@goatskins.test']) {
    await enqueue(email); assert.equal(await recovery.processarUma(), true); assert.equal(await job(email), undefined);
  }
  assert.equal(calls.length, 0); assert.equal(await count('tokens_email'), 0);
});

test('queue PG: prepared token uses HMAC, expires from enqueue time, and audit failure rolls preparation back', options, async () => {
  const u = await account(); await enqueue(u.email);
  await store.db.run('UPDATE password_recovery_jobs SET criado_em=criado_em-300000,expira=expira-300000 WHERE email=?', [u.email]);
  const original = await job(u.email);
  await store.db.run("INSERT INTO recovery_test_failures VALUES('audit')");
  await assert.rejects(recovery.processarUma(), /controlled recovery audit failure/);
  const rolledBack = await job(u.email);
  assert.equal(rolledBack.token_hash, null); assert.equal(rolledBack.contexto, null); assert.equal(rolledBack.tentativas, 0);
  assert.equal(await count('tokens_email'), 0); assert.equal(calls.length, 0);
  await store.db.run('DELETE FROM recovery_test_failures');
  assert.equal(await recovery.processarUma(), true);
  const raw = /#redefinir=([a-f0-9]{64})/.exec(calls[0][2])[1];
  const expected = crypto.createHmac('sha256', cfg.EMAIL_CODE_SECRET).update('goatskins:password-recovery:v1:' + original.id).digest('hex');
  assert.equal(raw, expected);
  const token = await store.db.get('SELECT * FROM tokens_email WHERE user_id=?', [u.id]);
  assert.equal(token.token_hash, store.sha(raw)); assert.equal(token.expira, original.expira); assert.equal(token.usado, 0);
  assert.equal((await store.db.get("SELECT COUNT(*) n FROM audit_logs WHERE user_id=? AND acao='SENHA_RECUPERACAO_PEDIDA'", [u.id])).n, 1);
});

test('queue PG: uncertain provider acceptance retries the identical token, payload and idempotency key after profile/config changes', options, async () => {
  const u = await account(); await enqueue(u.email);
  send = async () => { throw new Error('controlled acceptance then timeout'); };
  await recovery.processarUma();
  const first = structuredClone(calls[0]), saved = await job(u.email);
  const oldFrom = cfg.EMAIL_FROM, oldUrl = cfg.APP_URL;
  try {
    cfg.EMAIL_FROM = 'Changed fixture <changed@goatskins.test>'; cfg.APP_URL = 'http://changed.goatskins.test';
    await store.db.run("UPDATE users SET nome='Changed fixture name' WHERE id=?", [u.id]);
    await due(u.email); send = async () => ({ simulado: true });
    await recovery.processarUma();
  } finally { cfg.EMAIL_FROM = oldFrom; cfg.APP_URL = oldUrl; }
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], first);
  assert.equal(first[3].idempotencyKey, 'password-recovery/' + saved.id);
  assert.equal(await job(u.email), undefined);
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM tokens_email WHERE user_id=?', [u.id])).n, 1);
  assert.equal((await store.db.get("SELECT COUNT(*) n FROM audit_logs WHERE user_id=? AND acao='SENHA_RECUPERACAO_PEDIDA'", [u.id])).n, 1);
});

test('queue PG: concurrent workers claim a job once without holding the database transaction during provider I/O', options, async () => {
  const u = await account(); await enqueue(u.email);
  const entered = deferred(), finish = deferred();
  send = async () => { entered.resolve(); return finish.promise; };
  const first = recovery.processarUma();
  try {
    await bounded(entered.promise);
    assert.equal(await recovery.processarUma(), false);
    // This transaction completes while the provider promise is blocked.
    await store.tx(() => store.db.get('SELECT 1 ok'));
    assert.equal(calls.length, 1);
  } finally { finish.resolve({ simulado: true }); await first; }
  assert.equal(await job(u.email), undefined);
});

test('queue PG: an expired lease is reclaimable and an obsolete worker cannot delete the new owner retry', options, async () => {
  const u = await account(); await enqueue(u.email);
  const entered = deferred(), finish = deferred();
  send = async () => { if (calls.length === 1) { entered.resolve(); return finish.promise; } throw new Error('controlled retry failure'); };
  const first = recovery.processarUma();
  try {
    await bounded(entered.promise);
    const claimed = await job(u.email);
    await store.db.run('UPDATE password_recovery_jobs SET lease_ate=0,proximo=0 WHERE email=?', [u.email]);
    assert.equal(await recovery.processarUma(), true);
    const retry = await job(u.email);
    assert.equal(retry.tentativas, 2); assert.equal(retry.dono, null); assert.ok(retry.proximo > Date.now());
    assert.deepEqual(calls[1], calls[0]);
    finish.resolve({ simulado: true }); await first;
    const afterOldAck = await job(u.email);
    assert.equal(afterOldAck.id, claimed.id); assert.equal(afterOldAck.tentativas, 2);
    await due(u.email); send = async () => ({ simulado: true });
    await recovery.processarUma(); assert.equal(await job(u.email), undefined);
  } finally { finish.resolve({ simulado: true }); await first; }
});

test('queue PG: expired requests never mint tokens and retry exhaustion preserves a previously accepted capability', options, async () => {
  const u = await account(); await enqueue(u.email);
  await store.db.run('UPDATE password_recovery_jobs SET expira=? WHERE email=?', [Date.now() - 1, u.email]);
  assert.equal(await recovery.processarUma(), false); await recovery.limpar();
  assert.equal(await job(u.email), undefined); assert.equal(await count('tokens_email'), 0);
  await enqueue(u.email); send = async () => { throw new Error('controlled provider unavailable'); };
  for (let i = 0; i < 5; i++) { await due(u.email); assert.equal(await recovery.processarUma(), true); }
  assert.equal(calls.length, 5); assert.equal(await job(u.email), undefined);
  assert.equal(await recovery.processarUma(), false);
  assert.equal(new Set(calls.map(args => JSON.stringify(args))).size, 1);
  const token = await store.db.get('SELECT * FROM tokens_email WHERE user_id=?', [u.id]);
  assert.equal(token.usado, 0); assert.ok(token.expira > Date.now());
});

test('queue PG: changing the recovery secret fails closed instead of mailing a token different from the stored capability', options, async () => {
  const u = await account(); await enqueue(u.email);
  send = async () => { throw new Error('controlled timeout'); }; await recovery.processarUma();
  const token = await store.db.get('SELECT * FROM tokens_email WHERE user_id=?', [u.id]);
  const secret = cfg.EMAIL_CODE_SECRET;
  try { cfg.EMAIL_CODE_SECRET = 'b'.repeat(64); await due(u.email); await recovery.processarUma(); }
  finally { cfg.EMAIL_CODE_SECRET = secret; }
  assert.equal(calls.length, 1); assert.equal(await job(u.email), undefined);
  assert.equal((await store.db.get('SELECT * FROM tokens_email WHERE user_id=?', [u.id])).token_hash, token.token_hash);
});

test('queue PG: successful reset cancels queued requests that were not prepared and does not remint a token', options, async () => {
  const u = await account(), raw = crypto.randomBytes(32).toString('hex'); await enqueue(u.email);
  await store.db.run("INSERT INTO tokens_email(token_hash,user_id,tipo,expira) VALUES(?,?,'REDEFINIR',?)", [store.sha(raw), u.id, Date.now() + 60000]);
  assert.deepEqual(await handler('/api/redefinir-senha')({ ...ctx(u), body: { token: raw, senha: 'ChangedRecovery456' } }), { ok: true });
  assert.equal(await job(u.email), undefined); assert.equal(await recovery.processarUma(), false);
  assert.equal(await count('tokens_email'), 0); assert.equal(calls.length, 0);
});

test('queue PG: a link sent by the durable worker remains consumable and reset revokes prepared and unprepared requests', options, async () => {
  const u = await account(); await enqueue(u.email);
  // A timeout after provider acceptance leaves a prepared retry job and a usable sent link.
  send = async () => { throw new Error('controlled accepted message timeout'); };
  await recovery.processarUma();
  const raw = /#redefinir=([a-f0-9]{64})/.exec(calls[0][2])[1];
  await enqueue(u.email);
  assert.equal(await count('password_recovery_jobs'), 2);
  assert.deepEqual(await handler('/api/redefinir-senha')({ ...ctx(u), body: { token: raw, senha: 'ChangedRecovery456' } }), { ok: true });
  assert.equal(await count('password_recovery_jobs'), 0); assert.equal(await count('tokens_email'), 0);
  assert.equal(await recovery.processarUma(), false);
  assert.equal(calls.length, 1);
  assert.equal(await auth.confere('ChangedRecovery456', (await store.db.get('SELECT hash FROM users WHERE id=?', [u.id])).hash), true);
});

test('queue PG: password changes cancel unprepared recovery requests without reminting their tokens', options, async () => {
  const u = await account(); await enqueue(u.email);
  assert.deepEqual(await handler('/api/conta/senha')({ ...ctx(u), body: { atual: 'FixtureRecovery123', nova: 'ChangedRecovery456' } }), { ok: true });
  assert.equal(await job(u.email), undefined); assert.equal(await recovery.processarUma(), false);
  assert.equal(await count('tokens_email'), 0); assert.equal(calls.length, 0);
});

test('queue PG: account deletion cancels unprepared requests before anonymization can orphan them', options, async () => {
  const u = await account(); await enqueue(u.email);
  assert.deepEqual(await handler('/api/conta/excluir')({ ...ctx(u), body: { senha: 'FixtureRecovery123' } }), { ok: true });
  assert.equal(await job(u.email), undefined); assert.equal(await recovery.processarUma(), false);
  assert.equal((await store.db.get('SELECT status FROM users WHERE id=?', [u.id])).status, 'DELETED');
  assert.equal(calls.length, 0);
});

function cli(email) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', 'server.js', 'criar-admin', email, 'FixtureRecovery123', 'Recovery fixture'],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
}
test('queue PG: terminal administrator password replacement cancels unprepared recovery requests', options, async () => {
  const u = await account(); await enqueue(u.email);
  assert.equal(await cli(u.email), 0);
  assert.equal(await job(u.email), undefined); assert.equal(await recovery.processarUma(), false);
  assert.equal((await store.db.get('SELECT role FROM users WHERE id=?', [u.id])).role, 'SUPER_ADMIN');
  assert.equal(calls.length, 0);
});
