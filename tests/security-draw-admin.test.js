/* Real PostgreSQL regressions. Only disposable local TEST_DATABASE_URL is accepted;
   fixtures are unique, and no schema or pre-existing data is removed. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
let store, admin, draws, payments, mp;
let auditFailureUser = null;
let initialized = false;
const accounts = [], campaigns = [];
const settings = [];
const opts = { skip: !url, timeout: 15000 };

before(async () => {
  if (!url) return;
  require('./helpers/ambiente-teste');
  // Existing API suites reset public; isolate this suite before the application
  // opens a pool. Validate the base URL first, then add our own fixed search_path.
  const schema = 'security_draw_' + crypto.randomBytes(12).toString('hex');
  const bootstrap = new (require('pg').Pool)({ connectionString: url, connectionTimeoutMillis: 5000 });
  try { await bootstrap.query('CREATE SCHEMA "' + schema + '"'); }
  finally { await bootstrap.end(); }
  const scopedUrl = new URL(url); scopedUrl.searchParams.set('options', '-c search_path=' + schema);
  Object.assign(process.env, { DATABASE_URL: scopedUrl.toString(), TESTE: '1', PG_POOL_MAX: '6' });
  store = require('../src/db');
  const realAudit = store.audit;
  store.audit = async (...args) => {
    if (args[0] === auditFailureUser) throw new Error('Controlled fixture audit failure');
    return realAudit(...args);
  };
  admin = require('../src/admin');
  draws = require('../src/rifas'); payments = require('../src/pedidos'); mp = require('../src/mercadopago');
  await store.iniciar();
  initialized = true;
});
after(async () => {
  if (!store) return;
  try {
    if (!initialized) return;
    await store.tx(async () => {
      for (const key of settings) await store.db.run('DELETE FROM settings WHERE k=?', [key]);
      for (const id of campaigns) {
        await store.db.run('DELETE FROM winners WHERE campaign_id=?', [id]);
        await store.db.run('DELETE FROM tickets WHERE campaign_id=?', [id]);
        await store.db.run('DELETE FROM reservas WHERE campaign_id=?', [id]);
        await store.db.run('DELETE FROM pedidos WHERE campaign_id=?', [id]);
        await store.db.run('DELETE FROM campaigns WHERE id=?', [id]);
      }
      for (const id of accounts) {
        await store.db.run('DELETE FROM audit_logs WHERE user_id=?', [id]);
        await store.db.run('DELETE FROM users WHERE id=?', [id]);
      }
    });
  } finally { await store.fechar(); }
});
async function user(role = 'USER') {
  const contact = 'security-draw-' + crypto.randomBytes(12).toString('hex');
  const id = await store.db.insert('INSERT INTO users(nome,contato,hash,role,email_verificado,telefone) VALUES(?,?,?,?,1,?)', ['Security fixture', contact, 'fixture', role, '+5511999999999']);
  accounts.push(id);
  return { id, role, email_verificado: 1, celular_preenchido: true };
}
async function campaign(over = {}) {
  const seed = over.seed === undefined ? crypto.randomBytes(32).toString('hex') : over.seed;
  const commit = over.commit === undefined ? store.sha(seed) : over.commit;
  const id = await store.db.insert('INSERT INTO campaigns(premio,fim,max,max_por_usuario,seed,commit_hash,preco_centavos) VALUES(?,?,?,?,?,?,?)',
    ['Security fixture', '', over.max || 3, over.max || 3, seed, commit, over.price || 0]);
  campaigns.push(id); return { id, seed, commit };
}
const route = (mod, method, path) => mod.rotas.find(r => r[0] === method && r[1].test(path))[2];
const ctx = (id, actor, body = {}) => ({ params: [String(id)], user: actor, body, ip: '127.0.0.1' });
async function failingAudit(actor, operation) {
  auditFailureUser = actor.id;
  try { await assert.rejects(operation(), /Controlled fixture audit failure/); }
  finally { auditFailureUser = null; }
}

test('security: campaign creation rolls back when its audit cannot be recorded', opts, async () => {
  const actor = await user('ADMIN');
  const title = 'security-create-' + crypto.randomBytes(12).toString('hex');
  try {
    await failingAudit(actor, () => route(admin, 'POST', '/api/admin/campanhas')(ctx(0, actor, { premio: title, max: 2, max_por_usuario: 1 })));
    assert.equal((await store.db.get('SELECT COUNT(*) n FROM campaigns WHERE premio=?', [title])).n, 0);
  } finally {
    // On the vulnerable baseline, register the unexpectedly persisted fixture for cleanup.
    const rows = await store.db.all('SELECT id FROM campaigns WHERE premio=?', [title]);
    for (const row of rows) campaigns.push(row.id);
  }
});
test('security: closing a campaign rolls back if audit recording fails', opts, async () => {
  const actor = await user('ADMIN'), c = await campaign();
  await failingAudit(actor, () => route(admin, 'POST', '/api/admin/campanhas/1/encerrar')(ctx(c.id, actor)));
  assert.equal((await store.db.get('SELECT status FROM campaigns WHERE id=?', [c.id])).status, 'OPEN');
});
test('security: delivery attestation rolls back if audit recording fails', opts, async () => {
  const actor = await user('ADMIN'), participant = await user(), c = await campaign();
  await store.db.run('INSERT INTO winners(campaign_id,user_id,n,total,data) VALUES(?,?,1,1,?)', [c.id, participant.id, '2026-01-01']);
  await failingAudit(actor, () => route(admin, 'POST', '/api/admin/campanhas/1/entregar')(ctx(c.id, actor)));
  assert.deepEqual(await store.db.get('SELECT entregue_em,entregue_por FROM winners WHERE campaign_id=?', [c.id]), { entregue_em: null, entregue_por: null });
});
test('security: visual configuration and its audit commit together', opts, async () => {
  const actor = await user('ADMIN'), key = 'security-visual-' + crypto.randomBytes(12).toString('hex');
  settings.push(key);
  const initial = JSON.stringify({ titulo: 'Original fixture' });
  await store.db.run('INSERT INTO settings(k,v) VALUES(?,?)', [key, initial]);
  const originalRun = store.db.run;
  // Redirect only this fixed settings key to an isolated fixture. The actual
  // PostgreSQL write/transaction/rollback run normally, without touching site settings.
  store.db.run = (sql, args) => sql.startsWith("INSERT INTO settings(k,v) VALUES('visual',?)")
    ? originalRun(sql.replace("VALUES('visual',?)", 'VALUES(?,?)'), [key, ...args])
    : originalRun(sql, args);
  try {
    await failingAudit(actor, () => route(admin, 'PUT', '/api/admin/visual')(ctx(0, actor, {
      titulo: 'Changed fixture', sub: '', banner: '', cores: { gold: '#d4aa55', copper: '#b8651f', slate: '#3d4556', navy: '#0e1a33' }
    })));
  } finally { store.db.run = originalRun; }
  assert.equal((await store.db.get('SELECT v FROM settings WHERE k=?', [key])).v, initial);
});

async function closeRace(paid) {
  const actor = await user('ADMIN'), participant = await user(), c = await campaign({ price: paid ? 100 : 0 });
  const originalGet = store.db.get, originalRun = store.db.run;
  const originalMp = { configurado: mp.configurado, criarOrder: mp.criarOrder, buscarOrder: mp.buscarOrder, cancelarOrder: mp.cancelarOrder };
  let announce, release;
  const read = new Promise(r => announce = r), held = new Promise(r => release = r);
  const events = [];
  let paused = false;
  let providerEntry = true;
  if (paid) {
    // Every provider operation is local. No token, payment or network request is used.
    // Enable only the route's initial check. Its background sweep must remain disabled
    // so a shared disposable database cannot reconcile another suite's fixtures.
    mp.configurado = () => { const enabled = providerEntry; providerEntry = false; return enabled; };
    mp.criarOrder = async ({ ref, totalCentavos }) => ({ id: 'ORD' + crypto.randomBytes(12).toString('hex'), external_reference: ref,
      total_amount: (totalCentavos / 100).toFixed(2), status: 'action_required', status_detail: 'waiting_transfer',
      transactions: { payments: [{ status: 'action_required', payment_method: { id: 'pix' } }] } });
    mp.buscarOrder = mp.cancelarOrder = async () => { throw new Error('No external provider in security fixtures'); };
  }
  store.db.get = async (sql, args) => {
    const row = await originalGet(sql, args);
    if (!paused && sql === 'SELECT * FROM campaigns WHERE id=?' && args[0] === c.id) {
      paused = true; announce(); await held;
    }
    return row;
  };
  store.db.run = async (sql, args) => {
    if (sql.startsWith(paid ? 'INSERT INTO reservas' : 'INSERT INTO tickets') && args[0] === c.id) events.push('participant');
    if (sql.startsWith("UPDATE campaigns SET status='CLOSED'") && args[0] === c.id) events.push('close');
    return originalRun(sql, args);
  };
  const operation = route(paid ? payments : draws, 'POST', '/api/campanhas/1/' + (paid ? 'pedidos' : 'numeros'));
  const joining = operation(ctx(c.id, participant, { numeros: [1] }));
  let closing;
  try {
    await read;
    closing = route(admin, 'POST', '/api/admin/campanhas/1/encerrar')(ctx(c.id, actor));
    await new Promise(r => setTimeout(r, 120));
  } finally { release(); }
  try {
    await Promise.all([joining, closing]);
    assert.deepEqual(events, ['participant', 'close'], 'closing must wait for the in-flight participation transaction');
    assert.equal((await originalGet('SELECT status FROM campaigns WHERE id=?', [c.id])).status, 'CLOSED');
    assert.equal((await originalGet('SELECT COUNT(*) n FROM ' + (paid ? 'reservas' : 'tickets') + ' WHERE campaign_id=?', [c.id])).n, 1);
    providerEntry = true;
    await assert.rejects(operation(ctx(c.id, participant, { numeros: [2] })), /não está aberto/);
    assert.equal((await originalGet('SELECT COUNT(*) n FROM ' + (paid ? 'reservas' : 'tickets') + ' WHERE campaign_id=?', [c.id])).n, 1);
  } finally {
    store.db.get = originalGet; store.db.run = originalRun; Object.assign(mp, originalMp);
  }
}
test('security: campaign closing serializes with a free participation and blocks later tickets', opts, () => closeRace(false));
test('security: campaign closing serializes with a Pix reservation and blocks later orders', opts, () => closeRace(true));

test('security: a corrupt seed or commitment cannot produce a final draw', opts, async () => {
  const actor = await user('ADMIN'), participant = await user();
  for (const over of [{ commit: '0'.repeat(64) }, { seed: 'invalid-seed' }, { seed: null, commit: null }]) {
    const c = await campaign({ ...over, max: 1 });
    await store.db.run('INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES(?,?,1,?)', [c.id, participant.id, store.agora()]);
    await assert.rejects(draws.sortear(c.id, actor.id, '127.0.0.1'), e => e.code === 409 && /compromisso/i.test(e.message));
    assert.equal((await store.db.get('SELECT status FROM campaigns WHERE id=?', [c.id])).status, 'OPEN');
    assert.equal((await store.db.get('SELECT COUNT(*) n FROM winners WHERE campaign_id=?', [c.id])).n, 0);
  }
});
test('security: draw proof remains independently reproducible and forcedWinner input is ignored', opts, async () => {
  const actor = await user('ADMIN'), participant = await user(), c = await campaign({ max: 3 });
  for (const n of [1, 2, 3]) await store.db.run('INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES(?,?,?,?)', [c.id, participant.id, n, store.agora()]);
  const verification = route(draws, 'GET', '/api/campanhas/1/verificacao');
  const before = await verification(ctx(c.id));
  assert.equal(before.seed, undefined); assert.equal(before.commit_hash, c.commit);
  const snapshot = crypto.createHash('sha256').update('1,2,3').digest('hex');
  const digest = crypto.createHmac('sha256', c.seed).update(snapshot).digest('hex');
  const expected = [1, 2, 3][Number(BigInt('0x' + digest) % 3n)];
  const result = await route(admin, 'POST', '/api/admin/campanhas/1/sortear')(ctx(c.id, actor, { forcedWinner: expected === 1 ? 2 : 1, seed: '0'.repeat(64), numeros: [99], preview: true }));
  const proof = await verification(ctx(c.id));
  assert.equal(result.n, expected); assert.equal(proof.vencedor, expected);
  assert.equal(crypto.createHash('sha256').update(proof.seed).digest('hex'), proof.commit_hash);
  assert.equal(proof.snapshot_hash, snapshot); assert.deepEqual(proof.numeros, [1, 2, 3]);
  await assert.rejects(draws.sortear(c.id, actor.id, '127.0.0.1'), /já foi realizado/);
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM winners WHERE campaign_id=?', [c.id])).n, 1);
  assert.equal((await store.db.get("SELECT COUNT(*) n FROM audit_logs WHERE user_id=? AND acao='SORTEIO'", [actor.id])).n, 1);
  await assert.rejects(route(admin, 'PUT', '/api/admin/campanhas/1')(ctx(c.id, actor, { premio: 'Changed after draw', max: 3, max_por_usuario: 3 })), /não pode ser editado/);
  await assert.rejects(route(admin, 'DELETE', '/api/admin/campanhas/1')(ctx(c.id, actor)), /não pode ser excluído/);
  assert.equal((await store.db.get('SELECT premio FROM campaigns WHERE id=?', [c.id])).premio, 'Security fixture');
});
test('security: concurrent draw requests produce one winner and one audit event', opts, async () => {
  const actor = await user('ADMIN'), participant = await user(), c = await campaign({ max: 1 });
  await store.db.run('INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES(?,?,1,?)', [c.id, participant.id, store.agora()]);
  const results = await Promise.allSettled([draws.sortear(c.id, actor.id, '127.0.0.1'), draws.sortear(c.id, actor.id, '127.0.0.1')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /já foi realizado/);
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM winners WHERE campaign_id=?', [c.id])).n, 1);
  assert.equal((await store.db.get("SELECT COUNT(*) n FROM audit_logs WHERE user_id=? AND acao='SORTEIO'", [actor.id])).n, 1);
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=?', [participant.id])).n, 1);
});
test('security: a draw rolls back winner, status and notifications if audit fails', opts, async () => {
  const actor = await user('ADMIN'), participant = await user(), c = await campaign({ max: 1 });
  await store.db.run('INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES(?,?,1,?)', [c.id, participant.id, store.agora()]);
  await failingAudit(actor, () => draws.sortear(c.id, actor.id, '127.0.0.1'));
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM winners WHERE campaign_id=?', [c.id])).n, 0);
  assert.equal((await store.db.get('SELECT status FROM campaigns WHERE id=?', [c.id])).status, 'OPEN');
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=?', [participant.id])).n, 0);
});
