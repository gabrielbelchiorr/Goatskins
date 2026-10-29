/* Real PostgreSQL only, in a fresh schema of the guarded disposable local DB.
   Separate module instances model independent application workers at startup. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), { createRequire } = require('node:module');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const schema = 'rigorous_draw_' + crypto.randomBytes(10).toString('hex');
const opts = { skip: !url, timeout: 20000 };
let base, bootstrap, config;
const workers = [];

function load(file, overrides) {
  const filename = path.join(__dirname, '..', 'src', file);
  const nativeRequire = createRequire(filename);
  const sandbox = { module: { exports: {} }, Buffer, URL, console,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports;
}
function worker(seedRead) {
  const pg = require('pg');
  class ControlledPool extends pg.Pool {
    async query(sql, args) {
      const result = await super.query(sql, args);
      if (seedRead && /^SELECT id FROM campaigns WHERE seed IS NULL/.test(sql)) await seedRead(result.rows);
      return result;
    }
  }
  const store = load('db.js', { './config': config, pg: { ...pg, Pool: ControlledPool } });
  workers.push(store);
  return store;
}
before(async () => {
  if (!url) return;
  require('./helpers/ambiente-teste');
  bootstrap = new (require('pg').Pool)({ connectionString: url, connectionTimeoutMillis: 5000 });
  await bootstrap.query('CREATE SCHEMA ' + schema);
  const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema);
  config = { ...require('../src/config'), DATABASE_URL: scoped.toString(), DATABASE_SSL: false, PG_POOL_MAX: 5 };
  base = worker(); await base.iniciar();
});
after(async () => {
  for (const store of workers) await store.fechar();
  if (bootstrap) await bootstrap.end();
});
async function campaign(seed = null, commitment = null, status = 'OPEN') {
  return base.db.insert("INSERT INTO campaigns(premio,fim,max,max_por_usuario,seed,commit_hash,status) VALUES('Startup integrity fixture','',1,1,?,?,?)", [seed, commitment, status]);
}
async function participant() {
  const tag = crypto.randomBytes(10).toString('hex');
  const id = await base.db.insert("INSERT INTO users(nome,contato,hash,email_verificado,telefone) VALUES('Draw fixture',?,'fixture',1,'+5511999999999')", [tag]);
  return { id, role: 'USER', email_verificado: 1, celular_preenchido: true };
}
function claim(id, user, numeros) {
  const draws = load('rifas.js', { './db': base, './mail': { enviar: async () => {} }, './mercadopago': { configurado: () => false } });
  const route = draws.rotas.find(r => r[0] === 'POST' && r[1].test('/api/campanhas/1/numeros'));
  return route[2]({ params: [String(id)], user, body: { numeros }, ip: '127.0.0.1' });
}

test('PG: startup preserves an existing commitment when its secret seed is missing', opts, async () => {
  const original = base.novaSemente();
  const id = await campaign(null, original.commit);
  const restarted = worker(); await restarted.iniciar();
  const row = await base.db.get('SELECT seed,commit_hash,status FROM campaigns WHERE id=?', [id]);
  assert.equal(row.commit_hash, original.commit, 'startup must never replace a published commitment');
  assert.equal(row.seed, null, 'a missing committed secret must remain fail closed');
  const draws = load('rifas.js', { './db': restarted, './mail': { enviar: async () => {} }, './mercadopago': { configurado: () => false } });
  await assert.rejects(draws.sortear(id, null, '127.0.0.1'), e => e.code === 409 && /compromisso/.test(e.message));
  assert.equal((await base.db.get('SELECT COUNT(*) n FROM winners WHERE campaign_id=?', [id])).n, 0);
  assert.equal((await base.db.get('SELECT status FROM campaigns WHERE id=?', [id])).status, 'OPEN');
});

test('PG: restart preserves the commitment in an already published historical draw proof', opts, async () => {
  const original = base.novaSemente(), id = await campaign(null, original.commit, 'DRAWN');
  await base.db.run("INSERT INTO winners(campaign_id,user_id,n,total,data,seed_revelada,snapshot_hash) VALUES(?,1,1,1,'2026-10-29',?,?)", [id, original.seed, base.sha('1')]);
  const restarted = worker(); await restarted.iniciar();
  const row = await base.db.get('SELECT c.seed,c.commit_hash,w.seed_revelada FROM campaigns c JOIN winners w ON w.campaign_id=c.id WHERE c.id=?', [id]);
  assert.equal(row.commit_hash, base.sha(row.seed_revelada));
  assert.equal(row.commit_hash, original.commit);
  assert.equal(row.seed, null);
});

test('PG: two starting workers cannot replace the seed already initialized by another worker', opts, async () => {
  const id = await campaign();
  let announce, release;
  const read = new Promise(r => announce = r), held = new Promise(r => release = r);
  const first = worker(async rows => { assert.ok(rows.some(r => r.id === id)); announce(); await held; });
  const starting = first.iniciar();
  let committed;
  try {
    await read;
    const second = worker(); await second.iniciar();
    committed = await base.db.get('SELECT seed,commit_hash FROM campaigns WHERE id=?', [id]);
    assert.match(committed.seed, /^[a-f0-9]{64}$/);
    assert.equal(base.sha(committed.seed), committed.commit_hash);
  } finally { release(); }
  await starting;
  const final = await base.db.get('SELECT seed,commit_hash FROM campaigns WHERE id=?', [id]);
  assert.equal(final.seed, committed.seed, 'the first worker read stale NULL state and must not overwrite the second worker');
  assert.equal(final.commit_hash, committed.commit_hash);
});

test('PG: initial legacy seeding creates a valid commitment once and leaves completed draws unchanged', opts, async () => {
  const legacy = await campaign(), historical = await campaign(null, null, 'DRAWN');
  const restarted = worker(); await restarted.iniciar();
  const row = await base.db.get('SELECT seed,commit_hash FROM campaigns WHERE id=?', [legacy]);
  assert.match(row.seed, /^[a-f0-9]{64}$/); assert.equal(base.sha(row.seed), row.commit_hash);
  const again = worker(); await again.iniciar();
  assert.deepEqual(await base.db.get('SELECT seed,commit_hash FROM campaigns WHERE id=?', [legacy]), row);
  const past = await base.db.get('SELECT seed,commit_hash,status FROM campaigns WHERE id=?', [historical]);
  assert.equal(past.seed, null); assert.equal(past.commit_hash, null); assert.equal(past.status, 'DRAWN');
});

test('PG: competing free claims produce one ticket, one audit and one notification', opts, async () => {
  const id = await campaign(), people = await Promise.all(Array.from({ length: 12 }, participant));
  const results = await Promise.allSettled(people.map(u => claim(id, u, [1])));
  const success = results.findIndex(r => r.status === 'fulfilled');
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const result of results.filter(r => r.status === 'rejected')) {
    assert.equal(result.reason.code, 400); assert.match(result.reason.message, /escolhido/);
  }
  const tickets = await base.db.all('SELECT user_id,n FROM tickets WHERE campaign_id=?', [id]);
  assert.deepEqual(tickets, [{ user_id: people[success].id, n: 1 }]);
  for (let i = 0; i < people.length; i++) {
    const expected = i === success ? 1 : 0;
    assert.equal((await base.db.get("SELECT COUNT(*) n FROM audit_logs WHERE user_id=? AND acao='NUMEROS_ESCOLHIDOS'", [people[i].id])).n, expected);
    assert.equal((await base.db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=?', [people[i].id])).n, expected);
  }
});

test('PG: concurrent free claims by one account cannot exceed the campaign limit', opts, async () => {
  const id = await campaign(), user = await participant();
  await base.db.run('UPDATE campaigns SET max=12 WHERE id=?', [id]);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => claim(id, user, [i + 1])));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const result of results.filter(r => r.status === 'rejected')) {
    assert.equal(result.reason.code, 400); assert.match(result.reason.message, /Limite/);
  }
  assert.equal((await base.db.get('SELECT COUNT(*) n FROM tickets WHERE campaign_id=? AND user_id=?', [id, user.id])).n, 1);
  assert.equal((await base.db.get("SELECT COUNT(*) n FROM audit_logs WHERE user_id=? AND acao='NUMEROS_ESCOLHIDOS'", [user.id])).n, 1);
  assert.equal((await base.db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=?', [user.id])).n, 1);
});

test('PG: a conflicting free claim rolls back its earlier number and supports a clean retry', opts, async () => {
  const id = await campaign(), owner = await participant(), other = await participant();
  await base.db.run('UPDATE campaigns SET max=2,max_por_usuario=2 WHERE id=?', [id]);
  await claim(id, owner, [2]);
  await assert.rejects(claim(id, other, [1, 2]), e => e.code === 400 && /escolhido/.test(e.message));
  assert.deepEqual(await base.db.all('SELECT user_id,n FROM tickets WHERE campaign_id=? ORDER BY n', [id]), [{ user_id: owner.id, n: 2 }]);
  assert.equal((await base.db.get('SELECT COUNT(*) n FROM audit_logs WHERE user_id=?', [other.id])).n, 0);
  assert.equal((await base.db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=?', [other.id])).n, 0);
  await claim(id, other, [1, 1]);
  assert.deepEqual(await base.db.all('SELECT user_id,n FROM tickets WHERE campaign_id=? ORDER BY n', [id]), [{ user_id: other.id, n: 1 }, { user_id: owner.id, n: 2 }]);
});
