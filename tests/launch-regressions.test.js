/* Offline: no database, real mail or payment provider. */
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function load(file,mocks){const sandbox={module:{exports:{}},require:n=>{if(n in mocks)return mocks[n];throw Error('Unexpected import '+n);},setInterval:()=>({unref(){}}),Buffer,Date,console};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/',file),'utf8'),sandbox);return sandbox.module.exports;}
class Erro extends Error{constructor(message,code=400){super(message);this.code=code;}}
test('admin status reads role inside transaction and cannot suspend a promoted super admin',async()=>{
 let inside=false,writes=0;
 const mod=load('admin.js',{'./db':{db:{get:async()=>{assert.equal(inside,true);return {role:'SUPER_ADMIN'};},run:async()=>{writes++;}},tx:async fn=>{inside=true;try{return await fn();}finally{inside=false;}},agora:()=>''},'./http':{Erro},'./rifas':{}});
 const route=mod.rotas.find(r=>r[0]==='PUT'&&r[1].test('/api/admin/usuarios/2/status'));
 await assert.rejects(route[2]({params:['2'],body:{status:'SUSPENDED'},user:{id:1,role:'ADMIN'}}),e=>e.code===403);assert.equal(writes,0);
});
test('role change and session invalidation share the transaction',async()=>{
 let inside=false;const calls=[];
 const mod=load('admin.js',{'./db':{db:{get:async()=>{assert.ok(inside);return {role:'USER'};},run:async sql=>{assert.ok(inside);calls.push(sql);}},tx:async fn=>{inside=true;try{return await fn();}finally{inside=false;}},agora:()=>'',audit:async()=>{assert.ok(inside);}},'./http':{Erro},'./rifas':{}});
 const route=mod.rotas.find(r=>r[0]==='PUT'&&r[1].test('/api/admin/usuarios/2/papel'));
 await route[2]({params:['2'],body:{role:'ADMIN'},user:{id:1,role:'SUPER_ADMIN'}});assert.equal(calls.length,2);assert.match(calls[1],/DELETE FROM sessions/);
});
test('account deletion rate limit runs before password verification or database reads',async()=>{
 let checked=0;const mod=load('auth.js',{'node:crypto':{},'./registration':{consumirLimite:async(key,max,window)=>{assert.equal(key,'excluir-conta:7');assert.equal(max,5);assert.equal(window,900000);checked++;throw new Erro('limit',429);}},'./config':{},'./mail':{},'./db':{db:{get:()=>{throw Error('Must not query');}}},'./http':{Erro,RE:{}}});
 const route=mod.rotas.find(r=>r[1].test('/api/conta/excluir'));await assert.rejects(route[2]({user:{id:7},body:{senha:'guess'}}),e=>e.code===429);assert.equal(checked,1);
});

function deletion(changes){
 const hash='salt:'+Buffer.alloc(64,1).toString('hex'),calls=[];
 const crypto={scrypt:(s,salt,n,cb)=>cb(null,Buffer.alloc(64,1)),timingSafeEqual:require('node:crypto').timingSafeEqual};
 const mod=load('auth.js',{'node:crypto':crypto,'./registration':{consumirLimite:async()=>{}},'./recovery':{cancelar:async()=>{}},'./config':{},'./mail':{},'./http':{Erro,RE:{}},'./db':{db:{get:async sql=>sql.includes('SELECT hash, role')?{hash,role:'USER',email:'fixture@goatskins.test'}:{n:0},run:async(sql,args)=>{calls.push({sql,args});return {changes};}},tx:fn=>fn(),agora:()=>'',audit:async()=>{}}});
 return {route:mod.rotas.find(r=>r[1].test('/api/conta/excluir'))[2],calls,hash,ctx:{user:{id:7},body:{senha:'password'},res:{setHeader(){}}}};
}
test('deletion rejects password/role/status changes during password verification',async()=>{
 const t=deletion(0);await assert.rejects(t.route(t.ctx),e=>e.code===401);assert.equal(t.calls.length,1);assert.match(t.calls[0].sql,/AND hash=\? AND role='USER' AND status='ACTIVE'/);assert.equal(t.calls[0].args[2],t.hash);
});
test('successful deletion removes reset tokens, pending legacy registration and sessions',async()=>{
 const t=deletion(1);await t.route(t.ctx);for(const table of ['tokens_email','pending_registrations','sessions'])assert.ok(t.calls.some(c=>c.sql.startsWith('DELETE FROM '+table+' WHERE user_id=')));
});
