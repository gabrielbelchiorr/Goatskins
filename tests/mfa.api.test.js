/* Real HTTP + SQL. Use only disposable TEST_DATABASE_URL; this test resets public schema. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),crypto=require('node:crypto');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/test/i.test(new URL(url).pathname))throw Error('Banco de teste obrigatório');
test('MFA: enrollment, encrypted secret, admin enforcement, rotation, replay and recovery',{skip:!url,timeout:60000},async()=>{
 const {Pool}=require('pg'),pool=new Pool({connectionString:url,connectionTimeoutMillis:5000,query_timeout:5000}),schema='public';
 await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
 const dbUrl=new URL(url);
 const port=5200+crypto.randomInt(500),base='http://127.0.0.1:'+port;
 const env={...process.env,NODE_ENV:'test',RENDER:'',TESTE:'1',DATABASE_URL:dbUrl.toString(),DATABASE_SSL:'0',PG_POOL_MAX:'1',PORT:String(port),APP_URL:base,EMAIL_DRIVER:'console',MFA_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),TURNSTILE_SITE_KEY:'',TURNSTILE_SECRET_KEY:'',MP_ACCESS_TOKEN:'',MP_WEBHOOK_SECRET:''};
 const run=(args)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,args,{env,stdio:'pipe'});let error='';p.stderr.on('data',b=>error+=b);p.on('exit',n=>n?reject(Error(error)):resolve());});
 let srv;
 try {
  await run(['server.js','criar-admin','mfa@teste.com','Admin1234','Admin']);
  srv=spawn(process.execPath,['server.js'],{env,stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  let cookie='';const req=async(path,body,customCookie)=>{const r=await fetch(base+path,{signal:AbortSignal.timeout(5000),method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Requested-With':'goatskins',Cookie:customCookie===undefined?cookie:customCookie},body:body?JSON.stringify(body):undefined});const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return {status:r.status,d:await r.json()};};
  assert.equal((await req('/api/login',{email:'mfa@teste.com',senha:'Admin1234'})).status,200);
  const old=cookie;
  assert.equal((await req('/api/admin/dashboard')).d.tipo,'MFA_REQUIRED');
  assert.equal((await req('/api/mfa/preparar',{senha:'errada'})).status,401);
  const prepared=await req('/api/mfa/preparar',{senha:'Admin1234'});assert.equal(prepared.status,200);assert.match(prepared.d.secret,/^[A-Z2-7]{32}$/);
  const stored=(await pool.query('SELECT secret FROM '+schema+'.admin_mfa')).rows[0].secret;assert.ok(!stored.includes(prepared.d.secret));
  const {totp}=require('../src/mfa'),code=totp(prepared.d.secret,Math.floor(Date.now()/30000));
  assert.equal((await req('/api/mfa/verificar',{senha:'Admin1234',codigo:'invalid'})).status,401);
  const verified=await req('/api/mfa/verificar',{senha:'Admin1234',codigo:code});assert.equal(verified.status,200);assert.equal(verified.d.recoveryCodes.length,8);assert.notEqual(cookie,old);
  assert.equal((await req('/api/admin/dashboard')).status,200);
  assert.equal((await req('/api/admin/dashboard',null,old)).status,401);
  assert.equal((await req('/api/mfa/verificar',{senha:'Admin1234',codigo:code})).status,401);
  assert.equal((await req('/api/mfa/preparar',{senha:'Admin1234'})).status,409);
  await pool.query('UPDATE '+schema+'.sessions SET mfa_until=0');
  assert.equal((await req('/api/admin/dashboard')).status,403);
  const recovery=verified.d.recoveryCodes[0];assert.equal((await req('/api/mfa/verificar',{senha:'Admin1234',codigo:recovery})).status,200);
  assert.equal((await req('/api/mfa/verificar',{senha:'Admin1234',codigo:recovery})).status,401);
  const hashes=(await pool.query('SELECT recovery_hashes FROM '+schema+'.admin_mfa')).rows[0].recovery_hashes;assert.ok(!hashes.includes(recovery));assert.equal(JSON.parse(hashes).length,7);
 } finally {if(srv&&srv.exitCode===null&&srv.signalCode===null){await new Promise(resolve=>{srv.once('exit',resolve);srv.kill();});}await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}
});
