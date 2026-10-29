/* Local HTTP + real, disposable PostgreSQL. The only instrumentation observes
   completed session lookup; it never grants access or changes a protection. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const cleanEnv = require('./helpers/ambiente-teste');
const schema = 'rigorous_auth_' + crypto.randomBytes(12).toString('hex');
const opts = { skip: !url, timeout: 30000 }, PASSWORD = 'LocalAuditSenha123';
let pool, store, auth, child, base, dir, hash, errors = '';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function freePort() {
  const server = require('node:net').createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
before(async () => {
  if (!url) return;
  const Pool = require('pg').Pool, setup = new Pool({ connectionString: url });
  try { await setup.query('CREATE SCHEMA ' + schema); } finally { await setup.end(); }
  const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goatskins-rigorous-auth-'));
  base = 'http://127.0.0.1:' + await freePort();
  Object.assign(process.env, cleanEnv, { DATABASE_URL: scoped.toString(), DATA_DIR: dir,
    TESTE: '', PG_POOL_MAX: '4', DATABASE_CA: '', TRUST_PROXY: '0', TRUST_PROXY_HOPS: '1',
    PORT: new URL(base).port, APP_URL: base, MP_API_BASE: 'http://127.0.0.1:9' });
  store = require('../src/db'); auth = require('../src/auth');
  await store.iniciar(); hash = await auth.hashSenha(PASSWORD);
  pool = new Pool({ connectionString: scoped.toString(), statement_timeout: 15000 });
  const preload = path.join(dir, 'observe-session.cjs');
  fs.writeFileSync(preload, `
    global.fetch = async () => { throw Error('Outbound network forbidden in auth fixture'); };
    const auth = require(${JSON.stringify(path.join(__dirname, '../src/auth'))});
    const original = auth.usuarioDaSessao, observed = new WeakSet();
    auth.usuarioDaSessao = async req => {
      const user = await original(req);
      const marker = req.headers['x-audit-marker'];
      if (user && marker && !observed.has(req) && process.send) {
        observed.add(req); process.send({kind:'session_lookup', marker});
      }
      return user;
    };
  `);
  child = spawn(process.execPath, ['--no-warnings', '--require', preload, 'server.js'], {
    env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  child.stderr.on('data', chunk => errors = (errors + chunk).slice(-6000));
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error('Auth fixture exited: ' + errors);
    try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) })).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Auth fixture failed to start: ' + errors);
});
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  if (store) await store.fechar();
  if (pool) { await pool.query('DROP SCHEMA ' + schema + ' CASCADE'); await pool.end(); }
  if (dir) {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^goatskins-rigorous-auth-/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
async function actor() {
  const email = 'audit-' + crypto.randomBytes(12).toString('hex') + '@goatskins.test';
  const result = await pool.query(`INSERT INTO users(nome,contato,email,hash,email_verificado,telefone,celular)
    VALUES('Audit fixture',$1,$1,$2,1,'+5511999999999','+5511999999999') RETURNING id`, [email, hash]);
  const a = { id: Number(result.rows[0].id), email, sid: crypto.randomBytes(32).toString('hex') };
  await pool.query('INSERT INTO sessions(token,user_id,expira) VALUES($1,$2,$3)', [sha(a.sid), a.id, Date.now() + 3600000]);
  return a;
}
async function call(a, method, pathname, body, headers = {}) {
  const r = await fetch(base + pathname, { method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'goatskins', ...(a ? { Cookie: 'sid=' + a.sid } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie') };
}
function observed(marker) {
  let handler, timer;
  const cancel = () => { clearTimeout(timer); child.off('message', handler); };
  const promise = new Promise((resolve, reject) => {
    handler = m => { if (m.kind === 'session_lookup' && m.marker === marker) { cancel(); resolve(); } };
    child.on('message', handler);
    timer = setTimeout(() => { cancel(); reject(Error('Initial authenticated lookup not observed: ' + errors)); }, 8000);
  });
  return { promise, cancel };
}
async function whileWaiting(a, method, pathname, body, revoke) {
  const client = await pool.connect(), marker = crypto.randomBytes(12).toString('hex');
  let request, observation;
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(727401)');
    observation = observed(marker);
    request = call(a, method, pathname, body, { 'X-Audit-Marker': marker }); request.catch(() => {});
    await observation.promise;
    await revoke(client, a);
    await client.query('COMMIT');
    return await request;
  } finally {
    observation?.cancel(); await client.query('ROLLBACK'); client.release();
    if (request) await request.catch(() => {});
  }
}
async function erase(client, a) {
  await client.query(`UPDATE users SET nome='Usuário removido',contato='removido-'||id::text,
    email=NULL,telefone=NULL,celular=NULL,hash='',status='DELETED' WHERE id=$1`, [a.id]);
  await client.query('DELETE FROM sessions WHERE user_id=$1', [a.id]);
}

for (const [method, pathname, body] of [
  ['PUT', '/api/conta', { nome: 'PII reinserida depois da exclusão', telefone: '11988887777' }],
  ['POST', '/api/celular', { telefone: '11988887777' }]
]) test('auth HTTP: deletion during queued ' + pathname + ' cannot reintroduce personal data', opts, async t => {
  const a = await actor();
  const response = await whileWaiting(a, method, pathname, body, erase);
  const u = (await pool.query('SELECT nome,email,telefone,celular,status FROM users WHERE id=$1', [a.id])).rows[0];
  t.diagnostic(JSON.stringify({ status: response.status, persisted: u }));
  assert.equal(response.status, 401, 'Revoked session must be refused before updating an erased account');
  assert.deepEqual(u, { nome: 'Usuário removido', email: null, telefone: null, celular: null, status: 'DELETED' });
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE user_id=$1 AND acao='PERFIL_ATUALIZADO'", [a.id])).rows[0].n), 0);
});

test('auth HTTP: session revocation while profile update waits prevents the write and audit', opts, async () => {
  const a = await actor();
  const response = await whileWaiting(a, 'PUT', '/api/conta', { nome: 'Unauthorized queued write' },
    (client, a) => client.query('DELETE FROM sessions WHERE user_id=$1', [a.id]));
  assert.equal(response.status, 401);
  assert.equal((await pool.query('SELECT nome FROM users WHERE id=$1', [a.id])).rows[0].nome, 'Audit fixture');
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE user_id=$1 AND acao='PERFIL_ATUALIZADO'", [a.id])).rows[0].n), 0);
});

for (const [name, revoke] of [
  ['expiration', (client, a) => client.query('UPDATE sessions SET expira=$1 WHERE user_id=$2', [Date.now() - 1, a.id])],
  ['suspension', (client, a) => client.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [a.id])],
  ['email verification revocation', (client, a) => client.query('UPDATE users SET email_verificado=0 WHERE id=$1', [a.id])]
]) test('auth HTTP: ' + name + ' while a profile write waits denies it without writing', opts, async () => {
  const a = await actor();
  const response = await whileWaiting(a, 'PUT', '/api/conta', { nome: 'Unauthorized queued write' }, revoke);
  assert.equal(response.status, 401);
  assert.equal((await pool.query('SELECT nome FROM users WHERE id=$1', [a.id])).rows[0].nome, 'Audit fixture');
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE user_id=$1 AND acao='PERFIL_ATUALIZADO'", [a.id])).rows[0].n), 0);
});

test('auth HTTP: revocation prevents a queued notification acknowledgment without changing its state', opts, async () => {
  const a = await actor();
  const n = (await pool.query("INSERT INTO notifications(user_id,titulo,texto,criado_em) VALUES($1,'Fixture','Unread','fixture') RETURNING id", [a.id])).rows[0].id;
  const response = await whileWaiting(a, 'POST', '/api/notificacoes/lidas', {},
    (client, a) => client.query('DELETE FROM sessions WHERE user_id=$1', [a.id]));
  assert.equal(response.status, 401);
  assert.equal((await pool.query('SELECT lida FROM notifications WHERE id=$1', [n])).rows[0].lida, 0);
});

for (const [name, revoke, expected] of [
  ['session revocation', (client, a) => client.query('DELETE FROM sessions WHERE user_id=$1', [a.id]), 401],
  ['phone removal', (client, a) => client.query('UPDATE users SET celular=NULL,telefone=NULL WHERE id=$1', [a.id]), 403]
]) test('auth HTTP: ' + name + ' while claiming numbers prevents tickets, audit and notifications', opts, async () => {
  const a = await actor();
  const campaign = (await pool.query("INSERT INTO campaigns(premio,fim,max,max_por_usuario) VALUES('Audit claim fixture','',2,2) RETURNING id")).rows[0].id;
  const response = await whileWaiting(a, 'POST', '/api/campanhas/' + campaign + '/numeros', { numeros: [1] }, revoke);
  assert.equal(response.status, expected);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM tickets WHERE campaign_id=$1', [campaign])).rows[0].n), 0);
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE user_id=$1 AND acao='NUMEROS_ESCOLHIDOS'", [a.id])).rows[0].n), 0);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM notifications WHERE user_id=$1', [a.id])).rows[0].n), 0);
});

test('auth HTTP: valid profile and phone updates preserve protected account attributes', opts, async () => {
  const a = await actor();
  const updated = await call(a, 'PUT', '/api/conta', { nome: 'Perfil autorizado', telefone: '11988887777',
    id: a.id + 1, role: 'SUPER_ADMIN', status: 'SUSPENDED', email: 'attacker@goatskins.test', email_verificado: 0, celular_verificado: 1 });
  assert.equal(updated.status, 200);
  const phone = await call(a, 'POST', '/api/celular', { telefone: '11977776666', user_id: a.id + 1 });
  assert.equal(phone.status, 200);
  const u = (await pool.query('SELECT nome,email,role,status,email_verificado,celular_verificado,celular FROM users WHERE id=$1', [a.id])).rows[0];
  assert.deepEqual(u, { nome: 'Perfil autorizado', email: a.email, role: 'USER', status: 'ACTIVE',
    email_verificado: 1, celular_verificado: 0, celular: '+5511977776666' });
});

test('auth HTTP: login rotates supplied session IDs; tampering and logout cannot reuse the session', opts, async () => {
  const a = await actor(), attackerSid = 'f'.repeat(64);
  const login = await call(null, 'POST', '/api/login', { email: a.email, senha: PASSWORD }, { Cookie: 'sid=' + attackerSid });
  assert.equal(login.status, 200); assert.match(login.cookie, /HttpOnly; SameSite=Lax; Path=\//);
  const sid = login.cookie.match(/^sid=([^;]+)/)[1]; assert.notEqual(sid, attackerSid);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM sessions WHERE token=$1 AND user_id=$2', [sha(sid), a.id])).rows[0].n), 1);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM sessions WHERE token=$1', [sid])).rows[0].n), 0);
  const authenticated = { ...a, sid };
  const altered = sid.slice(0, -1) + (sid.endsWith('0') ? '1' : '0');
  assert.equal((await call({ ...a, sid: altered }, 'GET', '/api/conta')).status, 401);
  assert.equal((await call(authenticated, 'POST', '/api/logout', {})).status, 200);
  assert.equal((await call(authenticated, 'GET', '/api/conta')).status, 401);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM sessions WHERE token=$1', [sha(sid)])).rows[0].n), 0);
});

test('auth HTTP: password change revokes all old sessions and opens one fresh unprivileged session', opts, async () => {
  const a = await actor(), otherSid = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions(token,user_id,expira) VALUES($1,$2,$3)', [sha(otherSid), a.id, Date.now() + 3600000]);
  const response = await call(a, 'POST', '/api/conta/senha', { atual: PASSWORD, nova: 'ReplacementSenha456' });
  assert.equal(response.status, 200); assert.ok(response.cookie);
  const freshSid = response.cookie.match(/^sid=([^;]+)/)[1]; assert.notEqual(freshSid, a.sid);
  for (const sid of [a.sid, otherSid]) assert.equal((await call({ ...a, sid }, 'GET', '/api/conta')).status, 401);
  assert.equal((await call({ ...a, sid: freshSid }, 'GET', '/api/conta')).status, 200);
  const sessions = (await pool.query('SELECT token,mfa_until,mfa_role FROM sessions WHERE user_id=$1', [a.id])).rows;
  assert.equal(sessions.length, 1); assert.equal(sessions[0].token, sha(freshSid)); assert.equal(Number(sessions[0].mfa_until), 0);
  const u = (await pool.query('SELECT hash FROM users WHERE id=$1', [a.id])).rows[0];
  assert.equal(await auth.confere('ReplacementSenha456', u.hash), true); assert.equal(await auth.confere(PASSWORD, u.hash), false);
});

test('auth HTTP: actual account erasure still succeeds and removes its sessions', opts, async () => {
  const a = await actor();
  const response = await call(a, 'POST', '/api/conta/excluir', { senha: PASSWORD });
  assert.equal(response.status, 200); assert.match(response.cookie, /Max-Age=0/);
  const u = (await pool.query('SELECT status,email,telefone,celular FROM users WHERE id=$1', [a.id])).rows[0];
  assert.deepEqual(u, { status: 'DELETED', email: null, telefone: null, celular: null });
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM sessions WHERE user_id=$1', [a.id])).rows[0].n), 0);
  assert.equal((await call(a, 'GET', '/api/conta')).status, 401);
});
