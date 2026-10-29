/* Real HTTP + local disposable PostgreSQL. Revoke an already authorized MFA
   request while its transaction waits for the shared lock; no providers involved.
   Optional local negative control: GOATSKINS_MFA_NEGATIVE_CONTROL=1 deliberately
   disables only the context wrapper in the temporary fixture process; tests must fail. */
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const cleanEnv = require('./helpers/ambiente-teste');
const negative = process.env.GOATSKINS_MFA_NEGATIVE_CONTROL === '1';
const schema = 'mfa_concurrency_' + crypto.randomBytes(12).toString('hex');
const opts = {skip: !url, timeout: 30000};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
let pool, child, base, tempDir, env, stderr = '';

async function unusedPort() {
  const server = require('node:net').createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function run(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(global.process.execPath, ['--no-warnings', ...args], {env, stdio: ['ignore', 'ignore', 'pipe']});
    let error = ''; process.stderr.on('data', data => error += data);
    process.once('error', reject); process.once('exit', code => code === 0 ? resolve() : reject(new Error('Local MFA fixture command failed: ' + error)));
  });
}
before(async () => {
  if (!url) return;
  pool = new (require('pg').Pool)({connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 15000});
  await pool.query('CREATE SCHEMA ' + schema);
  const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema);
  await pool.end();
  pool = new (require('pg').Pool)({connectionString: scoped.toString(), connectionTimeoutMillis: 5000, statement_timeout: 15000});
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goatskins-mfa-concurrency-'));
  base = 'http://127.0.0.1:' + await unusedPort();
  env = {...process.env, ...cleanEnv, DATABASE_URL: scoped.toString(), TESTE: '1', PG_POOL_MAX: '2',
    PORT: new URL(base).port, APP_URL: base, DATA_DIR: tempDir, MFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    MP_API_BASE: 'http://127.0.0.1:9', GOATSKINS_MFA_NEGATIVE_CONTROL: negative ? '1' : ''};
  await run(['server.js', 'criar-admin', 'concurrency-bootstrap@goatskins.test', 'LocalFixture123', 'Local fixture']);
  const preload = path.join(tempDir, 'observe-mfa.cjs');
  fs.writeFileSync(preload, `
    // The fixture observes successful production authorization without changing it.
    global.fetch = async () => { throw Error('Outbound network is forbidden in MFA concurrency fixtures'); };
    const store = require(${JSON.stringify(path.join(__dirname, '../src/db'))});
    if (process.env.GOATSKINS_MFA_NEGATIVE_CONTROL === '1') {
      if (!process.env.DATABASE_URL.includes(${JSON.stringify(schema)})) throw Error('Unsafe negative control');
      store.comAutorizacao = (_verify, operation) => operation();
    }
    const mfa = require(${JSON.stringify(path.join(__dirname, '../src/mfa'))});
    const original = mfa.exigir;
    mfa.exigir = async ctx => {
      const result = await original(ctx);
      if (ctx.body && ctx.body.pentestMarker && process.send)
        process.send({kind:'mfa_authorized', marker:ctx.body.pentestMarker});
      return result;
    };
  `, 'utf8');
  child = spawn(process.execPath, ['--no-warnings', '--require', preload, 'server.js'], {env, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  child.stderr.on('data', data => {stderr = (stderr + data).slice(-6000);});
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('Local MFA fixture exited: ' + stderr);
    try {if ((await fetch(base + '/healthz', {signal: AbortSignal.timeout(500)})).ok) return;} catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Local MFA fixture failed to start: ' + stderr);
});
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {child.once('exit', resolve); child.kill();});
  }
  if (pool) await pool.end();
  if (tempDir) {
    assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(tempDir), /^goatskins-mfa-concurrency-/);
    fs.rmSync(tempDir, {recursive: true, force: true});
  }
  // Schema is unique and retained in the disposable cluster. No existing data is removed.
});

function cipher(uid) {
  const iv = crypto.randomBytes(12), encrypt = crypto.createCipheriv('aes-256-gcm', Buffer.from(env.MFA_ENCRYPTION_KEY, 'hex'), iv);
  encrypt.setAAD(Buffer.from('GOATSKINS:admin-mfa:v1:' + uid));
  const body = Buffer.concat([encrypt.update('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'), encrypt.final()]);
  return ['v1', iv.toString('base64'), encrypt.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}
async function actor() {
  const email = 'mfa-race-' + crypto.randomBytes(12).toString('hex') + '@goatskins.test';
  const result = await pool.query("INSERT INTO users(nome,contato,email,hash,role,email_verificado) VALUES('Local race fixture',$1,$1,'fixture-unused','ADMIN',1) RETURNING id", [email]);
  const id = Number(result.rows[0].id), sid = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO admin_mfa(user_id,secret,enabled,last_step,recovery_hashes) VALUES($1,$2,1,0,\'[]\')', [id, cipher(id)]);
  await pool.query("INSERT INTO sessions(token,user_id,expira,mfa_until,mfa_role) VALUES($1,$2,$3,$4,'ADMIN')", [sha(sid), id, Date.now() + 3600000, Date.now() + 900000]);
  return {id, sid};
}
async function call(actor, pathname, body) {
  const response = await fetch(base + pathname, {method: 'POST', headers: {'Content-Type': 'application/json',
    'X-Requested-With': 'goatskins', Cookie: 'sid=' + actor.sid}, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)});
  return {status: response.status, data: await response.json()};
}
function authorized(marker) {
  let handler, timer;
  const done = () => {clearTimeout(timer); child.off('message', handler);};
  const promise = new Promise((resolve, reject) => {
    handler = message => {if (message.kind === 'mfa_authorized' && message.marker === marker) {done(); resolve();}};
    timer = setTimeout(() => {done(); reject(new Error('Initial MFA authorization was not observed: ' + stderr));}, 8000);
    child.on('message', handler);
  });
  return {promise, cancel: done};
}
async function waitingMutation(actor, pathname, body, revoke) {
  const locker = await pool.connect(), marker = crypto.randomBytes(12).toString('hex');
  let request, observation;
  try {
    await locker.query('BEGIN'); await locker.query('SELECT pg_advisory_xact_lock(727401)');
    observation = authorized(marker);
    request = call(actor, pathname, {...body, pentestMarker: marker});
    request.catch(() => {}); // The observation failure must not leave an unhandled fetch rejection.
    await observation.promise;
    await revoke(locker, actor);
    await locker.query('COMMIT');
    const response = await request;
    assert.ok([401, 403].includes(response.status), 'Mutation after revocation must be denied, received ' + JSON.stringify(response));
    return response;
  } finally {
    observation?.cancel();
    await locker.query('ROLLBACK'); locker.release();
    if (request) await request.catch(() => {});
  }
}

const revocations = [
  ['session revocation', (client, actor) => client.query('DELETE FROM sessions WHERE user_id=$1', [actor.id])],
  ['session expiration', (client, actor) => client.query('UPDATE sessions SET expira=$1 WHERE user_id=$2', [Date.now() - 1, actor.id])],
  ['MFA elevation expiration', (client, actor) => client.query('UPDATE sessions SET mfa_until=$1 WHERE user_id=$2', [Date.now() - 1, actor.id])],
  ['role demotion', (client, actor) => client.query("UPDATE users SET role='USER' WHERE id=$1", [actor.id])],
  ['account suspension', (client, actor) => client.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [actor.id])],
  ['factor deactivation', (client, actor) => client.query('UPDATE admin_mfa SET enabled=0 WHERE user_id=$1', [actor.id])]
];
for (const [name, revoke] of revocations) {
  test('MFA transaction: ' + name + ' while waiting for the write lock prevents creation and its audit', opts, async () => {
    const a = await actor(), title = 'MFA race ' + crypto.randomBytes(12).toString('hex');
    await waitingMutation(a, '/api/admin/campanhas', {premio: title, max: 2, max_por_usuario: 1}, revoke);
    assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM campaigns WHERE premio=$1', [title])).rows[0].n), 0);
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE user_id=$1 AND acao='SORTEIO_CRIADO'", [a.id])).rows[0].n), 0);
  });
}

test('MFA transaction: revoked session cannot attest a refund after waiting for the write lock', opts, async () => {
  const a = await actor(), ref = crypto.randomBytes(16).toString('hex');
  const campaign = await pool.query("INSERT INTO campaigns(premio,fim,max,max_por_usuario,preco_centavos) VALUES('Local refund race','',1,1,100) RETURNING id");
  await pool.query("INSERT INTO pedidos(public_id,user_id,campaign_id,numeros,total_centavos,status,expira_em,criado_em,atualizado_em) VALUES($1,$2,$3,'[1]',100,'REFUND_NEEDED',$4,'fixture','fixture')",
    [ref, a.id, campaign.rows[0].id, Date.now() - 1000]);
  await waitingMutation(a, '/api/admin/pedidos/' + ref + '/reembolsado', {}, revocations[0][1]);
  assert.equal((await pool.query('SELECT status FROM pedidos WHERE public_id=$1', [ref])).rows[0].status, 'REFUND_NEEDED');
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE acao='PEDIDO_REEMBOLSADO' AND detalhe=$1", [ref])).rows[0].n), 0);
});

test('MFA transaction: authorization lost during a mutation rolls back both the mutation and audit before commit', opts, async () => {
  const a = await actor(), title = 'MFA commit race ' + crypto.randomBytes(12).toString('hex');
  assert.ok(Number.isSafeInteger(a.id) && a.id > 0);
  await pool.query(`CREATE FUNCTION mfa_expire_during_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.criado_por=${a.id} THEN UPDATE sessions SET mfa_until=0 WHERE user_id=${a.id}; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER mfa_expire_during_insert BEFORE INSERT ON campaigns FOR EACH ROW EXECUTE FUNCTION mfa_expire_during_insert()');
  try {
    const response = await call(a, '/api/admin/campanhas', {premio: title, max: 2, max_por_usuario: 1});
    assert.equal(response.status, 403, JSON.stringify(response));
    assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM campaigns WHERE premio=$1', [title])).rows[0].n), 0);
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE user_id=$1 AND acao='SORTEIO_CRIADO'", [a.id])).rows[0].n), 0);
    assert.ok(Number((await pool.query('SELECT mfa_until FROM sessions WHERE user_id=$1', [a.id])).rows[0].mfa_until) > Date.now(), 'The injected expiration is rolled back with the rejected transaction');
  } finally {
    await pool.query('DROP TRIGGER mfa_expire_during_insert ON campaigns');
    await pool.query('DROP FUNCTION mfa_expire_during_insert()');
  }
});
