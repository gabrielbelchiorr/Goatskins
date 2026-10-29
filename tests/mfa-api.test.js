/* Controlled pentest: real HTTP and PostgreSQL in a fresh schema of a guarded disposable database.
   No production domain, real payment, Resend, Twilio, or Turnstile call is made. */
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const cleanEnv = require('./helpers/ambiente-teste');
const schema = 'mfa_api_' + crypto.randomBytes(12).toString('hex');
const PASSWORD = 'MfaFixtureSenha123', sha = value => crypto.createHash('sha256').update(value).digest('hex');
const cases = { skip: !url, timeout: 45000 };
let pool, env, server, dataDir, fixtureHash, seq = 0;
const servers = new Set();

function run(args, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', ...args], { env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error('Local fixture command failed: ' + error)));
  });
}

async function unusedPort() {
  const socket = require('node:net').createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); return port;
}

async function start(overrides = {}) {
  const port = await unusedPort(), base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    env: { ...env, PORT: String(port), APP_URL: base, ...overrides }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = ''; child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-6000); });
  const instance = { child, base, errors: () => errors }; servers.add(instance);
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw new Error('Local MFA fixture server exited: ' + errors);
    try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) })).ok) return instance; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Local MFA fixture did not become healthy: ' + errors);
}

async function stop(instance) {
  if (!instance) return;
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    await new Promise(resolve => { instance.child.once('exit', resolve); instance.child.kill(); });
  }
  servers.delete(instance);
}

function client(instance = server) {
  let sid = '';
  const call = async (method, pathname, body, extra = {}) => {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'goatskins',
      ...(sid ? { Cookie: sid } : {}), ...(extra.headers || {}) };
    const response = await fetch(instance.base + pathname, { method, headers, redirect: 'manual',
      signal: AbortSignal.timeout(15000), body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie && extra.captureCookie !== false) sid = setCookie.split(';')[0];
    return { status: response.status, data: await response.json(), headers: response.headers, setCookie };
  };
  return { call, get: (p, e) => call('GET', p, undefined, e), post: (p, b, e) => call('POST', p, b, e), cookie: () => sid };
}

async function account(role = 'SUPER_ADMIN') {
  const email = 'mfa-fixture-' + (++seq) + '@goatskins.test';
  const result = await pool.query(`INSERT INTO users(nome,contato,email,hash,role,email_verificado)
    VALUES('MFA local fixture',$1,$1,$2,$3,1) RETURNING id`, [email, fixtureHash, role]);
  return { id: Number(result.rows[0].id), email, role };
}
async function login(user, instance = server, password = PASSWORD) {
  const c = client(instance), result = await c.post('/api/login', { email: user.email, senha: password });
  assert.equal(result.status, 200, JSON.stringify(result.data)); return c;
}

/* Independent fixture-code generator. The production primitive is checked against RFC vectors in mfa-unit. */
function code(secret, step = Math.floor(Date.now() / 30000)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let value = 0, bits = 0; const bytes = [];
  for (const char of secret) { value = (value << 5) | alphabet.indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = hmac[19] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function prepare(c) {
  const response = await c.post('/api/mfa/preparar', { senha: PASSWORD });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
}
async function enroll(user, offset = -1) {
  const c = await login(user), prepared = await prepare(c), oldCookie = c.cookie();
  const step = Math.floor(Date.now() / 30000) + offset;
  const verified = await c.post('/api/mfa/verificar', { senha: PASSWORD, codigo: code(prepared.secret, step) });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return { c, prepared, verified, oldCookie, step };
}

const ADMIN_PATHS = [
  ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/usuarios'],
  ['PUT', '/api/admin/usuarios/999999/status'], ['PUT', '/api/admin/usuarios/999999/papel'],
  ['GET', '/api/admin/logs'], ['GET', '/api/admin/campanhas/999999/participantes'],
  ['POST', '/api/admin/campanhas'], ['PUT', '/api/admin/campanhas/999999'],
  ['DELETE', '/api/admin/campanhas/999999'], ['GET', '/api/admin/campanhas/arquivadas'],
  ['POST', '/api/admin/campanhas/999999/arquivar'], ['POST', '/api/admin/campanhas/999999/desarquivar'],
  ['POST', '/api/admin/campanhas/999999/encerrar'], ['POST', '/api/admin/campanhas/999999/sortear'],
  ['GET', '/api/admin/ganhadores'], ['POST', '/api/admin/campanhas/999999/entregar'],
  ['PUT', '/api/admin/visual'], ['GET', '/api/admin/pedidos'],
  ['POST', '/api/admin/pedidos/' + 'a'.repeat(32) + '/reembolsado']
];

before(async () => {
  if (!url) return;
  const Pool = require('pg').Pool, setup = new Pool({ connectionString: url });
  try { await setup.query('CREATE SCHEMA ' + schema); } finally { await setup.end(); }
  const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goatskins-mfa-fixture-'));
  env = { ...process.env, ...cleanEnv, TESTE: '1', DATABASE_URL: scoped.toString(), PG_POOL_MAX: '5',
    DATA_DIR: dataDir, MFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), MP_API_BASE: 'http://127.0.0.1:9' };
  await run(['server.js', 'criar-admin', 'mfa-bootstrap@goatskins.test', PASSWORD, 'MFA fixture']);
  pool = new Pool({ connectionString: scoped.toString(), statement_timeout: 10000, connectionTimeoutMillis: 5000 });
  fixtureHash = (await pool.query("SELECT hash FROM users WHERE email='mfa-bootstrap@goatskins.test'")).rows[0].hash;
  server = await start();
});

beforeEach(async () => { if (pool) await pool.query('DELETE FROM auth_rate_limits'); });
after(async () => {
  for (const instance of [...servers]) await stop(instance);
  if (pool) { await pool.query('DROP SCHEMA ' + schema + ' CASCADE'); await pool.end(); }
  if (dataDir) {
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^goatskins-mfa-fixture-/);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('MFA HTTP: all 19 admin routes, including draw and finance, enforce MFA before handler work', cases, async () => {
  const anonymous = client(), ordinary = await login(await account('USER'));
  const superAdmin = await login(await account()), admin = await login(await account('ADMIN'));
  const before = (await pool.query('SELECT (SELECT COUNT(*) FROM campaigns) campaigns,(SELECT COUNT(*) FROM pedidos) pedidos,(SELECT COUNT(*) FROM winners) winners')).rows;
  for (const [method, pathname] of ADMIN_PATHS) {
    const body = method === 'GET' ? undefined : { role: 'SUPER_ADMIN', mfa_until: Date.now() + 99999999, verified: true };
    assert.equal((await anonymous.call(method, pathname, body)).status, 401, pathname);
    assert.equal((await ordinary.call(method, pathname, body)).status, 403, pathname);
    for (const c of [admin, superAdmin]) {
      const r = await c.call(method, pathname, body, { headers: { 'X-MFA-Verified': 'true' } });
      assert.equal(r.status, 403, pathname);
      // ADMIN is denied by its role before the SUPER_ADMIN-only handler; SUPER_ADMIN must still pass MFA.
      if (c !== admin || !pathname.endsWith('/papel')) assert.equal(r.data.tipo, 'MFA_REQUIRED', pathname);
    }
  }
  assert.deepEqual((await pool.query('SELECT (SELECT COUNT(*) FROM campaigns) campaigns,(SELECT COUNT(*) FROM pedidos) pedidos,(SELECT COUNT(*) FROM winners) winners')).rows, before);
});

test('MFA HTTP: only authenticated administrators can configure, and password/client flags cannot bypass MFA', cases, async () => {
  const anonymous = client(), ordinary = await login(await account('USER')), user = await account('ADMIN'), c = await login(user);
  for (const [method, pathname] of [['GET', '/api/mfa/status'], ['POST', '/api/mfa/preparar'], ['POST', '/api/mfa/verificar']]) {
    const body = method === 'GET' ? undefined : { senha: PASSWORD, codigo: '123456', role: 'SUPER_ADMIN', enabled: true, verified: true };
    assert.equal((await anonymous.call(method, pathname, body)).status, 401);
    assert.equal((await ordinary.call(method, pathname, body)).status, 403);
  }
  const status = await c.get('/api/mfa/status');
  assert.equal(status.status, 200); assert.equal(status.data.required, true);
  assert.equal(status.data.enabled, false); assert.equal(status.data.verified, false);
  assert.equal((await c.post('/api/mfa/preparar', { senha: 'wrong-password' })).status, 401);
  assert.equal((await c.post('/api/mfa/verificar', { senha: PASSWORD, codigo: '123456', enabled: true, verified: true })).status >= 400, true);
  await c.call('PUT', '/api/conta', { nome: 'MFA local fixture', role: 'SUPER_ADMIN', mfa_until: Date.now() + 99999999, verified: true });
  const profile = await c.get('/api/conta'); assert.equal(profile.data.role, 'ADMIN');
  assert.equal((await c.get('/api/admin/dashboard')).data.tipo, 'MFA_REQUIRED');
});

test('MFA HTTP: enrollment returns local QR/compatible URI, encrypts the seed, and stores only recovery hashes', cases, async () => {
  const user = await account(), enrolled = await enroll(user);
  assert.match(enrolled.prepared.secret, /^[A-Z2-7]{32,}$/);
  const uri = new URL(enrolled.prepared.uri);
  assert.equal(uri.protocol, 'otpauth:'); assert.equal(uri.hostname, 'totp');
  assert.equal(uri.searchParams.get('secret'), enrolled.prepared.secret);
  assert.equal(uri.searchParams.get('issuer'), 'GOATSKINS');
  assert.equal(uri.searchParams.get('algorithm'), 'SHA1');
  assert.equal(uri.searchParams.get('digits'), '6'); assert.equal(uri.searchParams.get('period'), '30');
  assert.match(decodeURIComponent(uri.pathname), new RegExp(user.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(enrolled.prepared.qrCode, /^data:image\/(gif|png|svg\+xml);base64,/);
  assert.ok(Buffer.from(enrolled.prepared.qrCode.split(',')[1], 'base64').length > 100);
  const stored = (await pool.query('SELECT * FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0];
  assert.equal(Number(stored.enabled), 1); assert.ok(!stored.secret.includes(enrolled.prepared.secret));
  const codes = enrolled.verified.data.recoveryCodes;
  assert.equal(codes.length, 8); assert.equal(new Set(codes).size, 8);
  for (const recovery of codes) { assert.match(recovery, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/i); assert.ok(!stored.recovery_hashes.includes(recovery)); }
  const hashes = JSON.parse(stored.recovery_hashes);
  assert.equal(hashes.length, 8); for (const hash of hashes) assert.match(hash, /^[a-f0-9]{64}$/);
  const status = await enrolled.c.get('/api/mfa/status');
  assert.equal(status.data.verified, true); assert.equal(status.data.remainingRecoveryCodes, 8);
  assert.ok(!JSON.stringify(status.data).includes(enrolled.prepared.secret));
  assert.equal((await enrolled.c.get('/api/admin/dashboard')).status, 200);
  assert.equal((await enrolled.c.get('/api/admin/pedidos')).status, 200);
  assert.equal((await enrolled.c.post('/api/mfa/preparar', { senha: PASSWORD })).status, 409);
});

test('MFA HTTP: activation rotates the session, limits its lifetime, and revokes other sessions', cases, async () => {
  const user = await account(), c = await login(user), other = await login(user), old = c.cookie();
  const prepared = await prepare(c), before = Date.now();
  const r = await c.post('/api/mfa/verificar', { senha: PASSWORD, codigo: code(prepared.secret) });
  assert.equal(r.status, 200); assert.notEqual(c.cookie(), old);
  assert.match(r.setCookie, /HttpOnly/i); assert.match(r.setCookie, /SameSite=Lax/i);
  const maxAge = Number(r.setCookie.match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge >= 28795 && maxAge <= 28800);
  assert.equal((await c.get('/api/conta', { headers: { Cookie: old } })).status, 401);
  assert.equal((await other.get('/api/conta')).status, 401);
  const session = (await pool.query('SELECT * FROM sessions WHERE token=$1', [sha(c.cookie().slice(4))])).rows[0];
  assert.ok(Number(session.mfa_until) >= before + 14 * 60000 && Number(session.mfa_until) <= Date.now() + 15 * 60000);
  assert.ok(Number(session.expira) <= Date.now() + 8 * 3600000);
  assert.equal(session.mfa_role, user.role);
});

test('MFA HTTP: pending enrollment is session-bound, expires, and is not usable as an active factor', cases, async () => {
  const user = await account(), first = await login(user), second = await login(user), prepared = await prepare(first);
  const stolen = await second.post('/api/mfa/verificar', { senha: PASSWORD, codigo: code(prepared.secret) });
  assert.equal(stolen.status >= 400, true); assert.equal((await second.get('/api/admin/dashboard')).data.tipo, 'MFA_REQUIRED');
  await pool.query('UPDATE admin_mfa SET pending_expira=$1 WHERE user_id=$2', [Date.now() - 1, user.id]);
  assert.equal((await first.post('/api/mfa/verificar', { senha: PASSWORD, codigo: code(prepared.secret) })).status >= 400, true);
  assert.equal(Number((await pool.query('SELECT enabled FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0].enabled), 0);
  const again = await prepare(first);
  assert.notEqual(again.secret, prepared.secret);
  assert.equal((await first.post('/api/mfa/verificar', { senha: PASSWORD, codigo: code(again.secret) })).status, 200);
});

test('MFA HTTP: TOTP replay is rejected and concurrent verification consumes the step only once', cases, async () => {
  const user = await account(), enrolled = await enroll(user);
  const replay = await enrolled.c.post('/api/mfa/verificar', { senha: PASSWORD, codigo: code(enrolled.prepared.secret, enrolled.step) });
  assert.equal(replay.status, 401); assert.equal(replay.setCookie, null);
  const first = await login(user), second = await login(user), step = Math.floor(Date.now() / 30000);
  const request = { senha: PASSWORD, codigo: code(enrolled.prepared.secret, step) };
  const results = await Promise.all([first.post('/api/mfa/verificar', request), second.post('/api/mfa/verificar', request)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  assert.equal(Number((await pool.query('SELECT last_step FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0].last_step), step);
});

test('MFA HTTP: a recovery code is single-use under races and revokes competing sessions', cases, async () => {
  const user = await account(), enrolled = await enroll(user), first = await login(user), second = await login(user);
  const body = { senha: PASSWORD, codigo: enrolled.verified.data.recoveryCodes[0] };
  const results = await Promise.all([first.post('/api/mfa/verificar', body), second.post('/api/mfa/verificar', body)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  const winner = results[0].status === 200 ? first : second, loser = winner === first ? second : first;
  assert.equal((await winner.post('/api/mfa/verificar', body)).status, 401);
  assert.equal((await loser.get('/api/conta')).status, 401);
  assert.equal((await winner.get('/api/mfa/status')).data.remainingRecoveryCodes, 7);
  assert.equal(JSON.parse((await pool.query('SELECT recovery_hashes FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0].recovery_hashes).length, 7);
});

test('MFA HTTP: expiration, inactive factor and role changes cannot reuse an elevated session', cases, async () => {
  const user = await account('ADMIN'), enrolled = await enroll(user), c = enrolled.c;
  await pool.query('UPDATE sessions SET mfa_until=$1 WHERE user_id=$2', [Date.now() - 1, user.id]);
  assert.equal((await c.get('/api/admin/dashboard')).data.tipo, 'MFA_REQUIRED');
  await pool.query('UPDATE sessions SET mfa_until=$1 WHERE user_id=$2', [Date.now() + 600000, user.id]);
  await pool.query('UPDATE admin_mfa SET enabled=0 WHERE user_id=$1', [user.id]);
  assert.equal((await c.get('/api/admin/dashboard')).data.tipo, 'MFA_REQUIRED');
  await pool.query("UPDATE admin_mfa SET enabled=1 WHERE user_id=$1", [user.id]);
  await pool.query("UPDATE users SET role='SUPER_ADMIN' WHERE id=$1", [user.id]);
  assert.equal((await c.get('/api/admin/dashboard')).data.tipo, 'MFA_REQUIRED');
  await pool.query("UPDATE users SET role='USER' WHERE id=$1", [user.id]);
  assert.equal((await c.get('/api/admin/dashboard')).status, 403);
  await pool.query('UPDATE sessions SET expira=$1 WHERE user_id=$2', [Date.now() - 1, user.id]);
  assert.equal((await c.get('/api/mfa/status')).status, 401);
});

test('MFA HTTP: persisted account limit counts failed attempts and survives a server restart', cases, async () => {
  const user = await account(), c = await login(user);
  for (let i = 0; i < 8; i++) assert.equal((await c.post('/api/mfa/preparar', { senha: 'wrong-password' })).status, 401);
  assert.equal((await c.post('/api/mfa/preparar', { senha: PASSWORD })).status, 429);
  const oldCookie = c.cookie(); await stop(server); server = await start();
  const restarted = client();
  const denied = await restarted.post('/api/mfa/preparar', { senha: PASSWORD }, { headers: { Cookie: oldCookie } });
  assert.equal(denied.status, 429);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0].n), 0);
});

test('MFA HTTP: the IP limit also bounds attempts spread across administrator accounts', cases, async () => {
  for (let i = 0; i < 5; i++) {
    const c = await login(await account());
    for (let j = 0; j < 8; j++) assert.equal((await c.post('/api/mfa/preparar', { senha: 'wrong-password' })).status, 401);
  }
  const sixth = await login(await account());
  assert.equal((await sixth.post('/api/mfa/preparar', { senha: PASSWORD })).status, 429);
});

test('MFA HTTP: audit failure rolls back factor activation, replay state and session rotation without a cookie', cases, async () => {
  const user = await account(), c = await login(user), prepared = await prepare(c), oldCookie = c.cookie();
  await pool.query(`CREATE FUNCTION mfa_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'controlled MFA audit failure'; END $$`);
  await pool.query(`CREATE TRIGGER mfa_test_audit_failure BEFORE INSERT ON audit_logs
    FOR EACH ROW WHEN (NEW.acao LIKE 'MFA%') EXECUTE FUNCTION mfa_test_audit_failure()`);
  try {
    const response = await c.post('/api/mfa/verificar', { senha: PASSWORD, codigo: code(prepared.secret) });
    assert.equal(response.status, 500); assert.equal(response.setCookie, null); assert.equal(c.cookie(), oldCookie);
    const pending = (await pool.query('SELECT enabled,last_step,recovery_hashes FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0];
    assert.equal(Number(pending.enabled), 0); assert.equal(Number(pending.last_step), -1); assert.deepEqual(JSON.parse(pending.recovery_hashes), []);
    assert.equal((await c.get('/api/conta')).status, 200); assert.equal((await c.get('/api/admin/dashboard')).data.tipo, 'MFA_REQUIRED');
  } finally { await pool.query('DROP TRIGGER mfa_test_audit_failure ON audit_logs'); await pool.query('DROP FUNCTION mfa_test_audit_failure()'); }
  assert.equal((await c.post('/api/mfa/verificar', { senha: PASSWORD, codigo: code(prepared.secret) })).status, 200);
});

test('MFA HTTP: password reset and the existing admin CLI preserve the enrolled factor', cases, async () => {
  const user = await account(), enrolled = await enroll(user), token = crypto.randomBytes(32).toString('hex');
  const original = (await pool.query('SELECT secret,recovery_hashes,last_step FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0];
  await pool.query("INSERT INTO tokens_email(token_hash,user_id,tipo,expira) VALUES($1,$2,'REDEFINIR',$3)", [sha(token), user.id, Date.now() + 60000]);
  const freshPassword = 'MfaFixtureNovaSenha456';
  assert.equal((await client().post('/api/redefinir-senha', { token, senha: freshPassword })).status, 200);
  assert.equal((await enrolled.c.get('/api/conta')).status, 401);
  const afterReset = await login(user, server, freshPassword);
  assert.equal((await afterReset.get('/api/admin/dashboard')).data.tipo, 'MFA_REQUIRED');
  assert.deepEqual((await pool.query('SELECT secret,recovery_hashes,last_step FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0], original);
  await run(['server.js', 'criar-admin', user.email, PASSWORD, 'MFA fixture']);
  assert.deepEqual((await pool.query('SELECT secret,recovery_hashes,last_step FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0], original);
  assert.equal((await afterReset.get('/api/conta')).status, 401);
  const afterCli = await login(user);
  assert.equal((await afterCli.get('/api/admin/dashboard')).data.tipo, 'MFA_REQUIRED');
  assert.equal((await afterCli.post('/api/mfa/verificar', { senha: PASSWORD, codigo: enrolled.verified.data.recoveryCodes[1] })).status, 200);
});

test('MFA HTTP: CSRF guards enrollment and verification without mutating the factor', cases, async () => {
  const user = await account(), c = await login(user);
  for (const pathname of ['/api/mfa/preparar', '/api/mfa/verificar']) {
    for (const headers of [{ 'X-Requested-With': '' }, { Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await c.post(pathname, { senha: PASSWORD, codigo: '123456' }, { headers })).status, 403);
    }
  }
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM admin_mfa WHERE user_id=$1', [user.id])).rows[0].n), 0);
});

test('MFA HTTP: no-key development server fails closed for setup and administrative access', cases, async () => {
  const missing = await start({ MFA_ENCRYPTION_KEY: '' });
  try {
    const c = await login(await account(), missing);
    for (const pathname of ['/api/mfa/status', '/api/mfa/preparar', '/api/mfa/verificar']) {
      const response = pathname.endsWith('status') ? await c.get(pathname) : await c.post(pathname, { senha: PASSWORD, codigo: '123456' });
      assert.equal(response.status, 503, pathname);
    }
    assert.equal((await c.get('/api/admin/dashboard')).status >= 400, true);
    assert.equal((await c.get('/api/conta')).status, 200);
  } finally { await stop(missing); }
});
