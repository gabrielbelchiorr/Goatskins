/* Real HTTP + SQL. Use only disposable TEST_DATABASE_URL; this test resets public schema. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),crypto=require('node:crypto');
const url=require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
test('admin: senha e MFA obrigatorios, permissoes, CSRF e sorteio',{skip:!url,timeout:60000},async()=>{
 const {Pool}=require('pg'),pool=new Pool({connectionString:url,connectionTimeoutMillis:5000,query_timeout:5000}),schema='public';
 await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
 const dbUrl=new URL(url);
 const port=5200+crypto.randomInt(500),base='http://127.0.0.1:'+port;
 const env={...process.env,NODE_ENV:'test',RENDER:'',TESTE:'1',DATABASE_URL:dbUrl.toString(),DATABASE_SSL:'0',PG_POOL_MAX:'1',PORT:String(port),APP_URL:base,EMAIL_DRIVER:'console',MFA_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),TURNSTILE_SITE_KEY:'',TURNSTILE_SECRET_KEY:'',MP_ACCESS_TOKEN:'',MP_WEBHOOK_SECRET:'',ORIGIN_VERIFY_SECRET:''};
 const run=(args)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,args,{env,stdio:'pipe'});let error='';p.stderr.on('data',b=>error+=b);p.on('exit',n=>n?reject(Error(error)):resolve());});
 let srv;
 try {
  await run(['server.js','criar-admin','admin@teste.com','Admin1234','Admin']);
  srv=spawn(process.execPath,['server.js'],{env,stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  let cookie='';const req=async(path,body,customCookie)=>{const r=await fetch(base+path,{signal:AbortSignal.timeout(5000),method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Requested-With':'goatskins',Cookie:customCookie===undefined?cookie:customCookie},body:body?JSON.stringify(body):undefined});const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return {status:r.status,d:await r.json()};};
  assert.equal((await req('/api/login',{email:'admin@teste.com',senha:'Admin1234'})).status,200);
  assert.equal((await req('/api/admin/dashboard')).d.tipo,'MFA_REQUIRED');
  const prepared=await req('/api/mfa/preparar',{senha:'Admin1234'});assert.equal(prepared.status,200);
  const otp=secret=>{let bits=0,value=0;const bytes=[];for(const c of secret){value=(value<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=crypto.createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=h[19]&15;return String((h.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');};
  const activated=await req('/api/mfa/verificar',{senha:'Admin1234',codigo:otp(prepared.d.secret)});assert.equal(activated.status,200);assert.equal(activated.d.recoveryCodes.length,8);
  assert.equal((await req('/api/admin/dashboard')).status,200);
  const draw=await pool.query("INSERT INTO campaigns(premio,fim,max,max_por_usuario,status,seed,commit_hash) VALUES('Roleta fixture','',1,1,'OPEN',$1,$2) RETURNING id",['a'.repeat(64),crypto.createHash('sha256').update('a'.repeat(64)).digest('hex')]);
  const drawPath='/api/admin/campanhas/'+draw.rows[0].id+'/sortear';
  assert.equal((await req(drawPath,{},'')).status,401);
  await pool.query("INSERT INTO users(nome,contato,hash,email_verificado) VALUES('Participante','participante-fixture','fixture',1)");
  await pool.query("INSERT INTO sessions(token,user_id,expira) SELECT $1,id,$2 FROM users WHERE contato='participante-fixture'",[crypto.createHash('sha256').update('fixture-user-session').digest('hex'),Date.now()+60000]);
  assert.equal((await req(drawPath,{},'sid=fixture-user-session')).status,403);
  const empty=await req(drawPath,{});assert.equal(empty.status,400);assert.match(empty.d.erro,/Ninguém participou/);assert.equal(empty.d.tipo,undefined);
  await pool.query("UPDATE users SET role='ADMIN' WHERE email='admin@teste.com'");
  assert.equal((await req('/api/admin/dashboard')).d.tipo,'MFA_REQUIRED');
  assert.equal((await req('/api/mfa/verificar',{senha:'Admin1234',codigo:activated.d.recoveryCodes[0]})).status,200);
  await pool.query("INSERT INTO tickets(campaign_id,user_id,n,criado_em) SELECT $1,id,1,'' FROM users WHERE contato='participante-fixture'",[draw.rows[0].id]);
  const csrf=await fetch(base+drawPath,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'});assert.equal(csrf.status,403);
  const drawn=await req(drawPath,{});assert.equal(drawn.status,200);assert.equal(drawn.d.n,1);
  assert.equal((await req(drawPath,{})).status,400);
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE acao='SORTEIO'")).rows[0].n),1);
  await pool.query("UPDATE users SET role='SUPER_ADMIN' WHERE email='admin@teste.com'");
  assert.equal((await req('/api/mfa/verificar',{senha:'Admin1234',codigo:activated.d.recoveryCodes[1]})).status,200);
  assert.equal((await req('/api/admin/dashboard')).status,200);
  assert.equal((await req('/api/admin/dashboard',null,'')).status,401);
  assert.equal((await req('/api/admin/dashboard',null,'sid=fixture-user-session')).status,403);
  assert.equal((await req('/api/mfa/status')).d.verified,true);
  assert.equal((await req('/api/mfa/status',{})).status,404);
  for(const path of ['/api/mfa/preparar','/api/mfa/verificar'])assert.equal((await req(path)).status,404);
 } finally {if(srv&&srv.exitCode===null&&srv.signalCode===null){await new Promise(resolve=>{srv.once('exit',resolve);srv.kill();});}await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}
});
