require('./helpers/ambiente-teste');
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
require('./helpers/pg-falso');
const cfg=require('../src/config'),sec=require('../src/security'),mfa=require('../src/mfa'),http=require('../src/http');
const originalFetch=global.fetch;
test.after(()=>{global.fetch=originalFetch;});
test('CSRF rejects foreign Origin even with custom header',()=>{
 const req={method:'POST',headers:{'x-requested-with':'goatskins',origin:'https://evil.example'}};
 assert.throws(()=>sec.csrf(req,'user'),e=>e.code===403);
 req.headers.origin=cfg.APP_URL;assert.doesNotThrow(()=>sec.csrf(req,'user'));
 req.headers['sec-fetch-site']='cross-site';assert.throws(()=>sec.csrf(req,'user'),e=>e.code===403);
 assert.doesNotThrow(()=>sec.csrf(req,'webhook'));
});
test('www redirects safe navigation to the canonical domain without weakening CSRF',()=>{
 const oldUrl=cfg.APP_URL, oldProduction=cfg.PRODUCAO;
 try {
   cfg.PRODUCAO=true; cfg.APP_URL='https://goatskins.com.br';
   const url=new URL('/?pagina=1', 'http://localhost');
   const req={method:'GET',headers:{host:'www.goatskins.com.br'}};
   assert.equal(sec.redirecionamentoWww(req,url),'https://goatskins.com.br/?pagina=1');
   req.method='HEAD'; assert.equal(sec.redirecionamentoWww(req,url),'https://goatskins.com.br/?pagina=1');
   req.method='POST'; assert.equal(sec.redirecionamentoWww(req,url),null);
   req.headers={'x-requested-with':'goatskins',origin:'https://www.goatskins.com.br',host:'www.goatskins.com.br'};
   assert.throws(()=>sec.csrf(req,'user'),e=>e.code===403);
   req.method='GET'; req.headers.host='www.evil.example';
   assert.equal(sec.redirecionamentoWww(req,url),null);
   req.headers.host='goatskins.com.br';
   assert.equal(sec.redirecionamentoWww(req,url),null);
   req.headers.host='www.goatskins.com.br';
   cfg.PRODUCAO=false;
   assert.equal(sec.redirecionamentoWww(req,url),null);
 } finally {cfg.APP_URL=oldUrl; cfg.PRODUCAO=oldProduction;}
});
test('limiter memory does not grow on blocked requests',()=>{
 const key='security-memory';http.limite(key,3,60000);http.limite(key,3,60000);http.limite(key,3,60000);
 for(let i=0;i<1000;i++)assert.throws(()=>http.limite(key,3,60000));
 assert.equal(http._baldes.get(key).ts.length,3);
});
test('Turnstile validates server response, action and hostname; fails closed',async()=>{
 cfg.TURNSTILE_SITE_KEY='site';cfg.TURNSTILE_SECRET_KEY='secret';
 await assert.rejects(sec.verificar('', 'registro'),e=>e.tipo==='TURNSTILE_REQUIRED');
 let answer={success:true,hostname:'localhost',action:'registro'};
 global.fetch=async(url,opts)=>{assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');assert.equal(JSON.parse(opts.body).secret,'secret');return {ok:true,json:async()=>answer};};
 await sec.verificar('token','registro');
 for(const bad of [{success:false},{hostname:'evil.test'},{action:'login'}]){
  const previous=answer;answer={...answer,...bad};await assert.rejects(sec.verificar('token','registro'),e=>e.code===403);answer=previous;
 }
 global.fetch=async()=>{throw Error('timeout');};await assert.rejects(sec.verificar('token','registro'),e=>e.code===503);
 cfg.TURNSTILE_SITE_KEY=cfg.TURNSTILE_SECRET_KEY='';global.fetch=originalFetch;
});
test('TOTP RFC 6238 SHA1 vectors (6 digits) and replay protection',()=>{
 const secret=mfa.base32(Buffer.from('12345678901234567890'));
 for(const [time,expected] of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']])assert.equal(mfa.totp(secret,Math.floor(time/30)),expected);
 assert.equal(mfa.check(secret,'287082',-1,59000),1);
 assert.equal(mfa.check(secret,'287082',1,59000),-1);
 assert.equal(mfa.check(secret,'287082',-1,180000),-1);
 assert.equal(mfa.check(secret,'123',-1,59000),-1);
});
test('MFA secrets encrypted with authenticated encryption',()=>{
 cfg.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
 const value='ABCDEFGHIJKLMNOP234567',a=mfa.encrypt(value),b=mfa.encrypt(value);
 assert.notEqual(a,b);assert.ok(!a.includes(value));assert.equal(mfa.decrypt(a),value);
 const parts=a.split('.');parts[2]=Buffer.from('tampered').toString('base64');assert.throws(()=>mfa.decrypt(parts.join('.')));
 cfg.MFA_ENCRYPTION_KEY='';
});
test('password-only and expired sessions cannot access admin when MFA configured',()=>{
 cfg.MFA_ENCRYPTION_KEY='b'.repeat(64);
 for(const u of [null,{}, {mfa_until:Date.now()-1}])assert.throws(()=>mfa.exigir(u),e=>e.tipo==='MFA_REQUIRED');
 assert.doesNotThrow(()=>mfa.exigir({mfa_until:Date.now()+10000}));cfg.MFA_ENCRYPTION_KEY='';
});
test('webhook rejects old correctly signed notifications and malformed timestamps',()=>{
 cfg.MP_WEBHOOK_SECRET='fixture';const mp=require('../src/mercadopago'),id='ORD123456789012';
 const sign=ts=>'ts='+ts+',v1='+crypto.createHmac('sha256','fixture').update('id:'+id.toLowerCase()+';request-id:req-1;ts:'+ts+';').digest('hex');
 assert.equal(mp.assinaturaValida(sign(Date.now()),'req-1',id),true);
 assert.equal(mp.assinaturaValida(sign(Date.now()-16*60000),'req-1',id),false);
 assert.equal(mp.assinaturaValida(sign('NaN'),'req-1',id),false);
});
