/* Audit failure injection in an isolated schema of the guarded disposable database. */
const {test,before,after} = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const url = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const schema='audit_events_'+crypto.randomBytes(8).toString('hex');
let store,auth,pool;
before(async()=>{
  if(!url)return;
  pool=new(require('pg').Pool)({connectionString:url}); await pool.query('CREATE SCHEMA '+schema);
  require('./helpers/ambiente-teste');
  const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema);
  Object.assign(process.env,{DATABASE_URL:scoped.toString(),TESTE:'1'});
  store=require('../src/db'); await store.iniciar();auth=require('../src/auth');
  require('../src/mail').enviar=async()=>true;
  await store.db.run('CREATE TABLE audit_fail_events(acao TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL)');
  await store.db.run(`CREATE FUNCTION fail_audit_event() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF EXISTS(SELECT 1 FROM audit_fail_events WHERE acao=NEW.acao AND enabled) THEN RAISE EXCEPTION 'controlled event failure'; END IF; RETURN NEW; END $f$`);
  await store.db.run('CREATE TRIGGER fail_audit_event BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_audit_event()');
});
after(async()=>{if(store)await store.fechar();if(pool)await pool.end();});
const opts={skip:!url,timeout:20000};
async function fail(action,enabled){await store.db.run('INSERT INTO audit_fail_events VALUES(?,?) ON CONFLICT(acao) DO UPDATE SET enabled=excluded.enabled',[action,enabled]);}
async function account(){
  const email=crypto.randomBytes(12).toString('hex')+'@goatskins.test',hash=await auth.hashSenha('FixtureAudit123');
  const id=await store.db.insert("INSERT INTO users(nome,contato,email,hash,email_verificado,telefone) VALUES('Original fixture',?,?,?,1,'+5511999999999')",[email,email,hash]);
  const ctx={user:{id,role:'USER'},ip:'127.0.0.1',req:{headers:{}},res:{setHeader(){}}};
  await auth.abrirSessao(ctx,id,hash); return{id,email,hash,ctx};
}
const handler=pathname=>auth.rotas.find(r=>r[0]!=='GET'&&r[1].test(pathname))[2];
test('PG: profile update rolls back when its audit cannot be written',opts,async()=>{
  const u=await account();await fail('PERFIL_ATUALIZADO',true);
  try{await assert.rejects(handler('/api/conta')({...u.ctx,body:{nome:'Changed fixture'}}),e=>e.code==='P0001');}
  finally{await fail('PERFIL_ATUALIZADO',false);}
  assert.equal((await store.db.get('SELECT nome FROM users WHERE id=?',[u.id])).nome,'Original fixture');
});
test('PG: password change, revocation and audit roll back together',opts,async()=>{
  const u=await account();await fail('SENHA_ALTERADA',true);
  try{await assert.rejects(handler('/api/conta/senha')({...u.ctx,body:{atual:'FixtureAudit123',nova:'ChangedFixture456'}}),e=>e.code==='P0001');}
  finally{await fail('SENHA_ALTERADA',false);}
  assert.equal((await store.db.get('SELECT hash FROM users WHERE id=?',[u.id])).hash,u.hash);
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id=?',[u.id])).n,1);
});
test('PG: account deletion rolls back anonymization and revocation when audit fails',opts,async()=>{
  const u=await account();await fail('CONTA_EXCLUIDA',true);
  try{await assert.rejects(handler('/api/conta/excluir')({...u.ctx,body:{senha:'FixtureAudit123'}}),e=>e.code==='P0001');}
  finally{await fail('CONTA_EXCLUIDA',false);}
  assert.deepEqual(await store.db.get('SELECT email,status FROM users WHERE id=?',[u.id]),{email:u.email,status:'ACTIVE'});
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id=?',[u.id])).n,1);
});
function cli(email){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--no-warnings','server.js','criar-admin',email,'FixtureAudit123','Audit fixture'],{env:process.env,stdio:['ignore','pipe','pipe']});
    // Do not reproduce command arguments or provider output in the report.
    child.stdout.resume();child.stderr.resume();
    const timer=setTimeout(()=>child.kill(),10000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve(code);});
  });
}
test('PG: terminal administrator creation is atomic with its audit and supports a clean retry',opts,async()=>{
  const email=crypto.randomBytes(12).toString('hex')+'@goatskins.test';await fail('ADMIN_CRIADO_PELO_TERMINAL',true);
  try{assert.notEqual(await cli(email),0);}
  finally{await fail('ADMIN_CRIADO_PELO_TERMINAL',false);}
  assert.equal((await store.db.get('SELECT COUNT(*) n FROM users WHERE email=?',[email])).n,0);
  assert.equal(await cli(email),0);
  assert.equal((await store.db.get('SELECT role FROM users WHERE email=?',[email])).role,'SUPER_ADMIN');
  assert.equal((await store.db.get("SELECT COUNT(*) n FROM audit_logs WHERE acao='ADMIN_CRIADO_PELO_TERMINAL' AND detalhe=?",[email])).n,1);
});
