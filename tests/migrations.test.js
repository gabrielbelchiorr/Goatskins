/* Migração em schema isolado de um banco descartável. Nunca aponta para produção. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const url=require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
test('migrações preservam dados antigos e adicionam a fila de recuperação sem órfãos',{skip:!url},async()=>{
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
  await c.query(migrations[5]);
  const migrated=(await c.query('SELECT * FROM users ORDER BY id')).rows;
  for(let i=0;i<migrated.length;i++){
    const {celular,celular_verificado,...old}=migrated[i];
    assert.deepEqual(old,antes[i]);assert.equal(celular,null);assert.equal(celular_verificado,0);
  }
  await c.query("UPDATE users SET celular='+5511999999999',celular_verificado=1 WHERE id=71");
  const before7=(await c.query('SELECT * FROM users ORDER BY id')).rows;
  await c.query(migrations[6]);
  assert.deepEqual((await c.query('SELECT * FROM users ORDER BY id')).rows,before7);
  assert.equal((await c.query("SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='ux_users_celular_confirmado'")).rows.length,0);
  await c.query("UPDATE users SET celular='+5511999999999',celular_verificado=1 WHERE id=72");
  assert.equal((await c.query('SELECT * FROM tickets')).rows.length,1);
  await c.query(migrations[7]);
  assert.equal((await c.query("SELECT to_regclass('admin_mfa') AS tabela")).rows[0].tabela,null);
  assert.equal((await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sessions' AND column_name='mfa_until'")).rows.length,0);
  assert.deepEqual((await c.query('SELECT token FROM sessions')).rows,[{token:'sessao-ok'}]);
  const before9={};
  for(const table of ['users','sessions','tokens_email','tickets','pedidos'])
    before9[table]=(await c.query('SELECT * FROM '+table+' ORDER BY 1')).rows;
  await c.query(migrations[8]);
  assert.equal((await c.query('SELECT * FROM password_recovery_jobs')).rows.length,0);
  for(const table of Object.keys(before9))
    assert.deepEqual((await c.query('SELECT * FROM '+table+' ORDER BY 1')).rows,before9[table]);
  await c.query(`INSERT INTO password_recovery_jobs(id,email,criado_em,expira,proximo,token_hash)
    VALUES($1,'antigo@teste.com',1,9999999999999,1,'recuperacao')`,['a'.repeat(64)]);
  await c.query("DELETE FROM tokens_email WHERE token_hash='recuperacao'");
  assert.equal((await c.query('SELECT * FROM password_recovery_jobs')).rows.length,0,'FK revoga o job junto do token');
  const before10={};
  for(const table of ['users','sessions','tokens_email','tickets','pedidos','password_recovery_jobs'])
    before10[table]=(await c.query('SELECT * FROM '+table+' ORDER BY 1')).rows;
  await c.query(migrations[9]);
  for(const table of Object.keys(before10).filter(t=>t!=='sessions'))
    assert.deepEqual((await c.query('SELECT * FROM '+table+' ORDER BY 1')).rows,before10[table]);
  const migratedSessions=(await c.query('SELECT * FROM sessions ORDER BY 1')).rows;
  for(let i=0;i<migratedSessions.length;i++){
    const {mfa_until,mfa_role,...old}=migratedSessions[i];
    assert.equal(Number(mfa_until),0);assert.equal(mfa_role,null);assert.deepEqual(old,before10.sessions[i]);
  }
  assert.equal((await c.query('SELECT * FROM admin_mfa')).rows.length,0);
  const before11={};
  for(const table of ['users','sessions','tokens_email','tickets','pedidos','campaigns'])
    before11[table]=(await c.query('SELECT * FROM '+table+' ORDER BY 1')).rows;
  await c.query(migrations[10]);
  for(const table of Object.keys(before11).filter(t=>t!=='campaigns'))
    assert.deepEqual((await c.query('SELECT * FROM '+table+' ORDER BY 1')).rows,before11[table]);
  const campaigns11=(await c.query('SELECT * FROM campaigns ORDER BY 1')).rows;
  for(let i=0;i<campaigns11.length;i++){
    const {inspect_link,modelo_3d_manual,...old}=campaigns11[i];
    assert.equal(inspect_link,'');assert.equal(modelo_3d_manual,0);assert.deepEqual(old,before11.campaigns[i]);
  }
  assert.equal((await c.query('SELECT * FROM campaign_presets')).rows.length,0);
  const columns11=(await c.query("SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='campaign_presets' AND column_name='dados'")).rows;
  assert.equal(columns11[0].data_type,'jsonb');
  await c.query("UPDATE campaigns SET inspect_link='steam://legacy-item',modelo_3d_manual=1 WHERE id=41");
  await c.query("INSERT INTO campaign_presets(nome,dados,criado_em,atualizado_em) VALUES('Modelo antigo',$1::jsonb,'antes','antes')",[JSON.stringify({premio:'Skin antiga',foto:'foto-preservada',inspect_link:'steam://legacy-item',modelo_3d_manual:1,max:10})]);
  const before12={};
  for(const table of ['users','sessions','tokens_email','tickets','pedidos','campaigns','campaign_presets'])
    before12[table]=(await c.query('SELECT * FROM '+table+' ORDER BY 1')).rows;
  await c.query(migrations[11]);
  for(const table of Object.keys(before12).filter(t=>!['campaigns','campaign_presets'].includes(t)))
    assert.deepEqual((await c.query('SELECT * FROM '+table+' ORDER BY 1')).rows,before12[table]);
  const after12=(await c.query('SELECT * FROM campaigns ORDER BY id')).rows;
  for(let i=0;i<after12.length;i++){
    const {viewer_3d,viewer_3d_pendente,...old}=after12[i];
    assert.equal(viewer_3d,null);assert.equal(viewer_3d_pendente,null);assert.deepEqual(old,before12.campaigns[i]);
  }
  const presets12=(await c.query('SELECT * FROM campaign_presets ORDER BY id')).rows;
  for(let i=0;i<presets12.length;i++){
    const {viewer_3d_pendente,...old}=presets12[i];
    assert.equal(viewer_3d_pendente,null);assert.deepEqual(old,before12.campaign_presets[i]);
  }
 } finally {await c.query('ROLLBACK');c.release();await pool.end();}
});

test('migrações 14 e 15: e-mail único, cópia das fotos para a tabela imagens sem apagar os originais',{skip:!url},async()=>{
 const {Pool}=require('pg'),pool=new Pool({connectionString:url}),c=await pool.connect(),schema='mig_'+require('node:crypto').randomBytes(8).toString('hex');
 const src=fs.readFileSync(path.join(__dirname,'../src/db.js'),'utf8');
 const migrations=vm.runInNewContext(src.slice(src.indexOf('const MIGRACOES ='),src.indexOf('async function migrar()'))+';MIGRACOES');
 const jpg='/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
 try {
  await c.query('BEGIN');
  await c.query('CREATE SCHEMA '+schema);await c.query('SET LOCAL search_path TO '+schema);
  for(const sql of migrations.slice(0,13))await c.query(sql);
  // 14 com duplicata em maiúsculas: não falha, cria só o índice comum
  await c.query("INSERT INTO users(nome,contato,email,hash) VALUES('A','a@x.com','dup@x.com','h'),('B','b@x.com','DUP@x.com','h')");
  await c.query('SAVEPOINT s14');
  await c.query(migrations[13]);
  const idx=(await c.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='users' AND indexname LIKE '%email_lower'")).rows.map(r=>r.indexname);
  assert.deepEqual(idx,['ix_users_email_lower']);
  await c.query('ROLLBACK TO SAVEPOINT s14');
  await c.query("DELETE FROM users WHERE contato='b@x.com'");
  await c.query(migrations[13]);
  assert.deepEqual((await c.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='users' AND indexname LIKE '%email_lower'")).rows.map(r=>r.indexname),['ux_users_email_lower']);
  await assert.rejects(c.query("INSERT INTO users(nome,contato,email,hash) VALUES('C','c@x.com','Dup@X.com','h')"),/ux_users_email_lower/);
  await c.query('ROLLBACK TO SAVEPOINT s14'); await c.query("DELETE FROM users WHERE contato='b@x.com'"); await c.query(migrations[13]);
  // 15: duas fotos boas, uma malformada e o banner no JSON do visual
  await c.query("INSERT INTO campaigns(id,premio,fim,max,foto) VALUES(1,'J','',5,$1),(2,'W','',5,$2),(3,'Ruim','',5,'data:image/jpeg;base64,***'),(4,'Sem','',5,'')",
    ['data:image/jpeg;base64,'+jpg,'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=']);
  await c.query("INSERT INTO settings(k,v) VALUES('visual',$1)",[JSON.stringify({titulo:'T',banner:'data:image/jpeg;base64,'+jpg})]);
  const antes={campaigns:(await c.query('SELECT * FROM campaigns ORDER BY id')).rows,settings:(await c.query('SELECT * FROM settings ORDER BY k')).rows};
  await c.query(migrations[14]);
  assert.deepEqual((await c.query('SELECT * FROM campaigns ORDER BY id')).rows,antes.campaigns);       // nada apagado
  assert.deepEqual((await c.query('SELECT * FROM settings ORDER BY k')).rows,antes.settings);
  const img=(await c.query('SELECT chave,tipo,dados,versao FROM imagens ORDER BY chave')).rows;
  assert.deepEqual(img.map(r=>r.chave+':'+r.tipo),['banner:image/jpeg','campanha:1:image/jpeg','campanha:2:image/webp']);   // a malformada ficou de fora
  assert.deepEqual(img[1].dados,Buffer.from(jpg,'base64'));
  assert.equal(img[1].versao,require('node:crypto').createHash('sha256').update(Buffer.from(jpg,'base64')).digest('hex').slice(0,16));
 } finally {await c.query('ROLLBACK');c.release();await pool.end();}
});
