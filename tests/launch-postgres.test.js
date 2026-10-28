/* Real PostgreSQL regressions; local disposable database only. */
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
let store, auth, admin;
before(async () => {
  if (!url) return;
  require('./helpers/ambiente-teste');
  Object.assign(process.env, { DATABASE_URL: url, TESTE: '1' });
  store = require('../src/db'); auth = require('../src/auth'); admin = require('../src/admin');
  await store.iniciar();
});
after(async () => { if (store) await store.fechar(); });
const options = { skip: !url, timeout: 15000 };
async function user(role = 'USER') {
  const contact = 'launch-' + require('node:crypto').randomBytes(8).toString('hex') + '@goatskins.test';
  const hash = await auth.hashSenha('Fixture1234');
  const id = await store.db.insert('INSERT INTO users(nome,contato,email,hash,role,email_verificado) VALUES(?,?,?,?,?,1)', ['Launch fixture', contact, contact, hash, role]);
  return { id, hash };
}
test('real database: account deletion rejects concurrent password, role or status change', options, async () => {
  const route = auth.rotas.find(r => r[1].test('/api/conta/excluir'))[2];
  for (const field of ['hash', 'role', 'status']) {
    const account = await user(), originalGet = store.db.get;
    const value = field === 'hash' ? await auth.hashSenha('Changed1234') : field === 'role' ? 'ADMIN' : 'SUSPENDED';
    let changed = false;
    // Update on another connection after the credential read, before scrypt/transaction.
    store.db.get = async (sql, args) => {
      const row = await originalGet(sql, args);
      if (!changed && sql === 'SELECT hash, role, email FROM users WHERE id=?' && args[0] === account.id) {
        changed = true;
        await store.db.run('UPDATE users SET ' + field + '=? WHERE id=?', [value, account.id]);
      }
      return row;
    };
    try {
      await assert.rejects(route({ user: { id: account.id }, body: { senha: 'Fixture1234' }, ip: '127.0.0.1', res: { setHeader() {} } }), e => e.code === 401);
    } finally { store.db.get = originalGet; }
    const row = await store.db.get('SELECT hash,role,status FROM users WHERE id=?', [account.id]);
    assert.equal(row[field], value); assert.notEqual(row.status, 'DELETED'); assert.ok(changed);
  }
});
test('real database: ADMIN suspension cannot overtake concurrent promotion to ADMIN', options, async () => {
  const target = await user(), actor = await user('ADMIN');
  let entered, release;
  const ready = new Promise(r => entered = r), held = new Promise(r => release = r);
  const promotion = store.tx(async () => {
    await store.db.run("UPDATE users SET role='ADMIN' WHERE id=?", [target.id]);
    entered(); await held;
  });
  await ready;
  const route = admin.rotas.find(r => r[0] === 'PUT' && r[1].test('/api/admin/usuarios/1/status'))[2];
  const suspension = assert.rejects(route({ params: [String(target.id)], user: { id: actor.id, role: 'ADMIN' }, body: { status: 'SUSPENDED' }, ip: '127.0.0.1' }), e => e.code === 403);
  try { await new Promise(r => setTimeout(r, 100)); } finally { release(); }
  await promotion; await suspension;
  const row = await store.db.get('SELECT role,status FROM users WHERE id=?', [target.id]);
  assert.deepEqual(row, { role: 'ADMIN', status: 'ACTIVE' });
});
test('real database: admin sees an old uncertain payment and its reservation remains protected', options, async () => {
  const account = await user(), ref = require('node:crypto').randomBytes(16).toString('hex');
  const campaign = await store.db.insert("INSERT INTO campaigns(premio,fim,max,max_por_usuario,preco_centavos) VALUES('Review fixture','',10,1,100)");
  const old = new Date(Date.now()-3600000).toISOString();
  const order = await store.db.insert('INSERT INTO pedidos(public_id,user_id,campaign_id,numeros,total_centavos,expira_em,criado_em,atualizado_em,mp_creation_uncertain) VALUES(?,?,?,?,?,?,?,?,1)', [ref, account.id, campaign, '[1]', 100, Date.now()-1800000, old, old]);
  await store.db.run('INSERT INTO reservas(campaign_id,n,pedido_id) VALUES(?,1,?)', [campaign, order]);
  const route = require('../src/pedidos').rotas.find(r => r[0]==='GET' && r[1].test('/api/admin/pedidos'));
  assert.equal(route[3], 'admin');
  const result = await route[2]();
  assert.equal(result.pedidos.find(p => p.id===ref).revisao_pagamento, true);
  assert.equal((await store.db.get('SELECT status FROM pedidos WHERE id=?', [order])).status, 'PENDING');
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM reservas WHERE pedido_id=?', [order])).n, 1);
});
