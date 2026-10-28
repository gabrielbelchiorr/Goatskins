/* Security regressions: actual payment handlers, simulated provider, disposable local PG only. */
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const baseUrl = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
class Erro extends Error { constructor(message, code = 400) { super(message); this.code = code; } }

test('unauthenticated webhook input cannot forge physical log lines', async () => {
  const logs = [], audits = [];
  const mocks = {
    'node:crypto': crypto, './config': {}, './mail': {},
    './mercadopago': {configurado: () => true, assinaturaValida: () => false},
    './db': {db:{}, audit: async (...args) => audits.push(args)},
    './http': {Erro, limite: () => {}}
  };
  const sandbox = {module:{exports:{}}, Buffer, Date,
    console: Object.fromEntries(['log','warn','error'].map(level => [level, (...args) => logs.push(args.map(String).join(' '))])),
    setInterval: () => ({unref(){}}), require: name => { assert(name in mocks, name); return mocks[name]; }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/pedidos.js'),'utf8'), sandbox);
  const handler = sandbox.module.exports.rotas.find(r => r[1].test('/api/webhooks/mercadopago'))[2];
  await assert.rejects(handler({query:{type:'order\r\nFORGED\u001b[2J', 'data.id':'ORD00000000000000001'}, body:{}, req:{headers:{}}, ip:'127.0.0.1'}), e => e.code === 401);
  assert(logs.length > 0);
  assert(logs.every(line => !/[\r\n\u001b]/.test(line)), 'Untrusted control characters must not become log records');
  for (const line of logs) {
    const record = JSON.parse(line); assert.equal(record.area, 'webhook');
  }
  assert.equal(audits.length, 1);
});

let store, payments, mp, mail, bootstrap, original;
const schema = 'audit_payments_' + crypto.randomBytes(8).toString('hex');
before(async () => {
  if (!baseUrl) return;
  bootstrap = new (require('pg').Pool)({connectionString:baseUrl});
  await bootstrap.query('CREATE SCHEMA ' + schema);
  require('./helpers/ambiente-teste');
  const scopedUrl = new URL(baseUrl); scopedUrl.searchParams.set('options', '-c search_path=' + schema);
  Object.assign(process.env, {DATABASE_URL:scopedUrl.toString(), TESTE:'1', MP_ACCESS_TOKEN:'fixture-local', MP_WEBHOOK_SECRET:'fixture-local'});
  store = require('../src/db'); await store.iniciar();
  mp = require('../src/mercadopago'); mail = require('../src/mail'); payments = require('../src/pedidos');
  original = {configurado:mp.configurado, criarOrder:mp.criarOrder, buscarOrder:mp.buscarOrder, enviar:mail.enviar};
  // No periodic sweep or provider request is allowed in this file.
  mp.configurado = () => false; mail.enviar = async () => true;
  mp.criarOrder = async () => { throw Error('Provider fixture was not installed'); };
  mp.buscarOrder = async () => { throw Error('Provider access is forbidden'); };
});
after(async () => {
  if (original) { Object.assign(mp, {configurado:original.configurado, criarOrder:original.criarOrder, buscarOrder:original.buscarOrder}); mail.enviar=original.enviar; }
  if (store) await store.fechar();
  if (bootstrap) await bootstrap.end();
  // Schema is intentionally retained in the disposable cluster; no schema resets or real data.
});
const pgOptions = {skip:!baseUrl, timeout:20000};
const route = (method, pathname) => payments.rotas.find(r => r[0] === method && r[1].test(pathname))[2];
async function fixture({status='PENDING', reserve=true, price=150, nums=[1,2], maxPerUser=2} = {}) {
  const tag=crypto.randomBytes(12).toString('hex');
  const userId = await store.db.insert("INSERT INTO users(nome,contato,email,hash,email_verificado,telefone) VALUES(?,?,?,'unused',1,'+5511999999999')", ['Audit payment',tag,tag+'@goatskins.test']);
  const seed = store.novaSemente();
  const campaignId = await store.db.insert("INSERT INTO campaigns(premio,fim,max,max_por_usuario,preco_centavos,seed,commit_hash) VALUES(?,'',10,?,?,?,?)", ['Audit '+tag,maxPerUser,price,seed.seed,seed.commit]);
  const ref = crypto.randomBytes(16).toString('hex'), orderId='ORD'+crypto.randomBytes(12).toString('hex').toUpperCase();
  const total = price * nums.length;
  const id = await store.db.insert('INSERT INTO pedidos(public_id,user_id,campaign_id,numeros,total_centavos,status,mp_order_id,expira_em,criado_em,atualizado_em) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [ref,userId,campaignId,JSON.stringify(nums),total,status,orderId,Date.now()+300000,store.agora(),store.agora()]);
  if (reserve) for (const n of nums) await store.db.run('INSERT INTO reservas(campaign_id,n,pedido_id) VALUES(?,?,?)',[campaignId,n,id]);
  return {id,ref,orderId,userId,campaignId,nums,total,user:{id:userId,nome:'Audit payment',email:tag+'@goatskins.test',celular_preenchido:true,email_verificado:1}};
}
const paid = p => ({id:p.orderId,external_reference:p.ref,currency_id:'BRL',status:'processed',status_detail:'accredited',
  total_amount:(p.total/100).toFixed(2),total_paid_amount:(p.total/100).toFixed(2),
  transactions:{payments:[{id:'PAYfixture',status:'processed',status_detail:'accredited',paid_amount:(p.total/100).toFixed(2),payment_method:{id:'pix',type:'bank_transfer'}}]}});
async function state(p) {
  return {
    status:(await store.db.get('SELECT status FROM pedidos WHERE id=?',[p.id])).status,
    tickets:(await store.db.get('SELECT COUNT(*) n FROM tickets WHERE campaign_id=? AND user_id=?',[p.campaignId,p.userId])).n,
    reserves:(await store.db.get('SELECT COUNT(*) n FROM reservas WHERE pedido_id=?',[p.id])).n,
    confirmations:(await store.db.get("SELECT COUNT(*) n FROM audit_logs WHERE acao='PAGAMENTO_CONFIRMADO' AND detalhe LIKE ?",['pedido '+p.id+' números %'])).n
  };
}

test('PG: parallel duplicate confirmations create exactly one financial effect', pgOptions, async () => {
  const p = await fixture();
  await Promise.all(Array.from({length:20}, () => payments.aplicar(p.id, paid(p))));
  assert.deepEqual(await state(p),{status:'PAID',tickets:2,reserves:0,confirmations:1});
  assert.equal((await store.db.get("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND titulo='Pagamento confirmado!'",[p.userId])).n,1);
});
test('PG: wrong amount, currency, order or reference never grants entries or frees reservation', pgOptions, async () => {
  const p=await fixture();
  for (const change of [{total_paid_amount:'0.01'},{total_amount:'0.01'},{currency_id:'USD'},{external_reference:'b'.repeat(32)},{id:'ORDOTHER000000000000000'}]) {
    assert.equal(await payments.aplicar(p.id,{...paid(p),...change}),'PENDING');
    assert.deepEqual(await state(p),{status:'PENDING',tickets:0,reserves:2,confirmations:0});
  }
});
test('PG: a provider/database interruption rolls the entire confirmation back and retry succeeds', pgOptions, async () => {
  const p=await fixture();
  await store.db.run('CREATE TABLE audit_fault_order(id BIGINT PRIMARY KEY, enabled BOOLEAN NOT NULL)');
  await store.db.run('INSERT INTO audit_fault_order VALUES(?,true)',[p.id]);
  await store.db.run(`CREATE FUNCTION audit_fail_paid() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF NEW.status='PAID' AND EXISTS(SELECT 1 FROM audit_fault_order WHERE id=NEW.id AND enabled) THEN RAISE EXCEPTION 'controlled fixture interruption'; END IF; RETURN NEW; END $f$`);
  await store.db.run('CREATE TRIGGER audit_fail_paid BEFORE UPDATE ON pedidos FOR EACH ROW EXECUTE FUNCTION audit_fail_paid()');
  await assert.rejects(payments.aplicar(p.id,paid(p)), e=>e.code==='P0001');
  assert.deepEqual(await state(p),{status:'PENDING',tickets:0,reserves:2,confirmations:0});
  await store.db.run('UPDATE audit_fault_order SET enabled=false WHERE id=?',[p.id]);
  assert.equal(await payments.aplicar(p.id,paid(p)),'PAID');
  assert.deepEqual(await state(p),{status:'PAID',tickets:2,reserves:0,confirmations:1});
});
test('PG: canceled and processed responses out of order remain idempotent', pgOptions, async () => {
  const p=await fixture(), canceled={...paid(p),status:'canceled',transactions:{payments:[{status:'canceled'}]}};
  await Promise.all(Array.from({length:12},(_,i)=>payments.aplicar(p.id,i%2?paid(p):canceled)));
  assert.deepEqual(await state(p),{status:'PAID',tickets:2,reserves:0,confirmations:1});
});
test('PG: late payment preserves money as REFUND_NEEDED when an entry belongs to someone else', pgOptions, async () => {
  const p=await fixture({status:'EXPIRED',reserve:false});
  const other=await store.db.insert("INSERT INTO users(nome,contato,hash,email_verificado) VALUES('Other fixture',?,'unused',1)",[crypto.randomBytes(12).toString('hex')]);
  await store.db.run('INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES(?,?,?,?)',[p.campaignId,other,p.nums[0],store.agora()]);
  assert.equal(await payments.aplicar(p.id,paid(p)),'REFUND_NEEDED');
  assert.deepEqual(await state(p),{status:'REFUND_NEEDED',tickets:0,reserves:0,confirmations:0});
  assert.equal((await store.db.get('SELECT user_id FROM tickets WHERE campaign_id=? AND n=?',[p.campaignId,p.nums[0]])).user_id,other);
});
test('PG: ownership checks reject reading and refreshing another account order without provider access', pgOptions, async () => {
  const p=await fixture(), ctx={params:[p.ref],user:{id:p.userId+1000000}};
  let calls=0; mp.buscarOrder=async()=>{calls++;throw Error('Provider must not be called');};
  await assert.rejects(route('GET','/api/pedidos/'+p.ref)(ctx),e=>e.code===404);
  await assert.rejects(route('POST','/api/pedidos/'+p.ref+'/atualizar')(ctx),e=>e.code===404);
  assert.equal(calls,0); assert.equal((await state(p)).status,'PENDING');
});
test('PG: refund attestation and its audit must commit together', pgOptions, async () => {
  const p=await fixture({status:'REFUND_NEEDED',reserve:false});
  await store.db.run('CREATE TABLE audit_fault_refund(ref TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL)');
  await store.db.run('INSERT INTO audit_fault_refund VALUES(?,true)',[p.ref]);
  await store.db.run(`CREATE FUNCTION audit_fail_refund() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF NEW.acao='PEDIDO_REEMBOLSADO' AND EXISTS(SELECT 1 FROM audit_fault_refund WHERE ref=NEW.detalhe AND enabled) THEN RAISE EXCEPTION 'controlled audit failure'; END IF; RETURN NEW; END $f$`);
  await store.db.run('CREATE TRIGGER audit_fail_refund BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_fail_refund()');
  const handler=route('POST','/api/admin/pedidos/'+p.ref+'/reembolsado'),ctx={params:[p.ref],user:{id:p.userId},ip:'127.0.0.1'};
  await assert.rejects(handler(ctx),e=>e.code==='P0001');
  assert.equal((await state(p)).status,'REFUND_NEEDED');
  await store.db.run('UPDATE audit_fault_refund SET enabled=false WHERE ref=?',[p.ref]);
  await handler(ctx); assert.equal((await state(p)).status,'REFUNDED');
  assert.equal((await store.db.get("SELECT COUNT(*) n FROM audit_logs WHERE acao='PEDIDO_REEMBOLSADO' AND detalhe=?",[p.ref])).n,1);
});
