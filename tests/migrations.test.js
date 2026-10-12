/* Migração em schema isolado de um banco descartável. Nunca aponta para produção. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/test/i.test(decodeURIComponent(new URL(url).pathname))) throw Error('Use um banco descartável com test no nome');
test('migrações 4 e 5 preservam dados e adicionam MFA sem ativar privilégios',{skip:!url},async()=>{
 const {Pool}=require('pg'),pool=new Pool({connectionString:url}),c=await pool.connect(),schema='mig_'+require('node:crypto').randomBytes(8).toString('hex');
 const src=fs.readFileSync(path.join(__dirname,'../src/db.js'),'utf8');
 const migrations=vm.runInNewContext(src.slice(src.indexOf('const MIGRACOES ='),src.indexOf('async function migrar()'))+';MIGRACOES');
 try {
  await c.query('BEGIN');
  await c.query('CREATE SCHEMA '+schema);await c.query('SET LOCAL search_path TO '+schema);
  for(const sql of migrations.slice(0,3))await c.query(sql);
  await c.query("INSERT INTO users(id,nome,contato,email,hash,role,email_verificado) VALUES(71,'Antigo','antigo@teste.com','antigo@teste.com','hash-antigo','ADMIN',0),(72,'Verificado','ok@teste.com','ok@teste.com','hash-ok','SUPER_ADMIN',1)");
  await c.query("INSERT INTO sessions VALUES('sessao-antiga',71,9999999999999),('sessao-ok',72,9999999999999)");
  await c.query("INSERT INTO tokens_email VALUES('link-antigo',71,'VERIFICAR',9999999999999,0),('recuperacao',71,'REDEFINIR',9999999999999,0)");
  await c.query("INSERT INTO campaigns(id,premio,fim,max,max_por_usuario) VALUES(41,'Skin','',10,1)");
  await c.query("INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES(41,71,2,'2026-01-01')");
  await c.query("INSERT INTO pedidos(public_id,user_id,campaign_id,numeros,total_centavos,expira_em,criado_em,atualizado_em) VALUES('pedido-antigo',71,41,'[3]',100,9999999999999,'','')");
  const antes=(await c.query('SELECT * FROM users ORDER BY id')).rows;
  await c.query(migrations[3]);
  assert.deepEqual((await c.query('SELECT * FROM users ORDER BY id')).rows,antes);
  assert.equal((await c.query('SELECT * FROM tickets')).rows.length,1);assert.equal((await c.query('SELECT * FROM pedidos')).rows.length,1);
  assert.deepEqual((await c.query('SELECT token FROM sessions')).rows,[{token:'sessao-ok'}]);
  assert.deepEqual((await c.query('SELECT tipo FROM tokens_email')).rows,[{tipo:'REDEFINIR'}]);
  assert.equal((await c.query('SELECT * FROM pending_registrations')).rows.length,0);
  await c.query(migrations[4]);
  assert.deepEqual((await c.query('SELECT * FROM users ORDER BY id')).rows,antes);
  assert.equal((await c.query('SELECT * FROM tickets')).rows.length,1);
  assert.equal((await c.query('SELECT mp_creation_uncertain FROM pedidos')).rows[0].mp_creation_uncertain,0);
  assert.equal(Number((await c.query('SELECT mfa_until FROM sessions')).rows[0].mfa_until),0);
  assert.equal((await c.query('SELECT * FROM admin_mfa')).rows.length,0);
 } finally {await c.query('ROLLBACK');c.release();await pool.end();}
});
