const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const url=require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
require('./helpers/ambiente-teste');
let pool,store,phone,srv,base,seq=0;
const schema='phone_'+crypto.randomBytes(8).toString('hex');
const run=(name,fn)=>test(name,{skip:!url},fn);
before(async()=>{
 if(!url)return;
 pool=new(require('pg').Pool)({connectionString:url});await pool.query('CREATE SCHEMA '+schema);
 const target=new URL(url);target.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=target.toString();
 store=require('../src/db');await store.iniciar();phone=require('../src/phone');
});
after(async()=>{if(!url)return;if(srv){srv.kill();await new Promise(r=>srv.once('exit',r));}await store.fechar();await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();});
async function account(number=null){
 const email='phone'+(++seq)+'@test.com',hash=await require('../src/auth').hashSenha('Senha12345');
 const id=await store.db.insert("INSERT INTO users(nome,contato,email,hash,email_verificado,celular) VALUES('Teste',?,?,?,1,?)",[email,email,hash,number]);
 return {user:{id},body:{telefone:number},email,ip:'127.0.0.1'};
}
run('valida DDD e E.164 e rejeita fixos, internacionais, ausentes e DDD inválido',()=>{
 for(const n of ['(11) 99999-9999','11999999999','+55 11 99999-9999'])assert.equal(phone.normalize(n),'+5511999999999');
 for(const n of ['',null,{},11999999999,'+11999999999','+1 2025550123','(20) 99999-9999','1133334444','abc11999999999'])assert.equal(phone.valid(n),false);
 assert.throws(()=>phone.exigir({email_verificado:1,celular_preenchido:false}),/celular válido/);
 assert.throws(()=>phone.exigir({email_verificado:0,celular_preenchido:true}),/e-mail/);
 assert.doesNotThrow(()=>phone.exigir({email_verificado:1,celular_preenchido:true,celular_verificado:0}));
});
run('salvar não verifica posse, aceita números repetidos e permite corrigir sem exclusividade',async()=>{
 const a=await account(),b=await account();a.body=b.body={telefone:'(11) 99999-9999',celular_verificado:1,phone_verified:true};
 await Promise.all([phone.save(a),phone.save(b)]);
 const rows=await store.db.all('SELECT celular,telefone,celular_verificado FROM users WHERE id IN (?,?)',[a.user.id,b.user.id]);
 for(const r of rows)assert.deepEqual(r,{celular:'+5511999999999',telefone:'+5511999999999',celular_verificado:0});
 a.body={telefone:'(21) 98888-8888'};await phone.save(a);assert.equal((await phone.status(a)).celular,'+5521988888888');
 a.body={telefone:'2133334444'};await assert.rejects(phone.save(a));assert.equal((await phone.status(a)).celular,'+5521988888888');
});
run('legado entra e preenche celular; APIs exigem e-mail e formato, sem SMS, sem expor número público',async()=>{
 const port=16000+crypto.randomInt(1000);base='http://127.0.0.1:'+port;
 srv=require('node:child_process').spawn(process.execPath,['server.js'],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,PORT:String(port),APP_URL:base},stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 const c=await account();let cookie='';
 async function req(route,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json','X-Requested-With':'goatskins'},body:body?JSON.stringify(body):undefined});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return {status:r.status,data:await r.json()};}
 assert.equal((await req('/api/login',{email:c.email,senha:'Senha12345'})).status,200);
 for(const route of ['/api/campanhas/1/numeros','/api/campanhas/1/pedidos'])assert.equal((await req(route,{numeros:[1],phone_verified:true,celular_preenchido:true})).status,403);
 assert.equal((await req('/api/celular',{telefone:'1133334444'})).status,400);
 assert.equal((await req('/api/celular',{telefone:'(11) 99999-9999',celular_verificado:1})).status,200);
 assert.equal((await store.db.get('SELECT celular_verificado FROM users WHERE id=?',[c.user.id])).celular_verificado,0);
 const state=(await req('/api/estado')).data;assert.equal(state.eu.celular_preenchido,true);assert.equal(state.eu.celular,undefined);assert.equal(state.eu.telefone,undefined);
 const campaign=await store.db.insert("INSERT INTO campaigns(premio,fim,max,max_por_usuario,status,preco_centavos) VALUES('Skin','',10,10,'OPEN',0)");
 assert.equal((await req('/api/campanhas/'+campaign+'/numeros',{numeros:[1]})).status,200);
 const paid=await store.db.insert("INSERT INTO campaigns(premio,fim,max,max_por_usuario,status,preco_centavos) VALUES('Pix','',10,10,'OPEN',100)");
 assert.notEqual((await req('/api/campanhas/'+paid+'/pedidos',{numeros:[1]})).status,403);
 await store.db.run("UPDATE users SET celular='inválido',telefone=NULL WHERE id=?",[c.user.id]);
 assert.equal((await req('/api/campanhas/'+campaign+'/numeros',{numeros:[2]})).status,403);
 await store.db.run("UPDATE users SET celular=NULL,telefone='(11) 99999-9999' WHERE id=?",[c.user.id]);assert.equal((await req('/api/estado')).data.eu.celular_preenchido,true);
 await store.db.run('UPDATE users SET email_verificado=0 WHERE id=?',[c.user.id]);assert.equal((await req('/api/campanhas/'+campaign+'/numeros',{numeros:[2]})).status,401);
 await store.db.run("UPDATE users SET email_verificado=1,celular=NULL,telefone=NULL,role='ADMIN' WHERE id=?",[c.user.id]);
 assert.equal((await req('/api/mfa/status')).status,503);assert.equal((await req('/api/campanhas/'+campaign+'/numeros',{numeros:[2]})).status,403);
 for(const route of ['/api/celular/enviar','/api/celular/confirmar','/api/celular/corrigir'])assert.equal((await req(route,{})).status,404);
});
