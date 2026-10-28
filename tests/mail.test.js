const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function carregar(fetch, extra = {}) {
  const cfg = { EMAIL_DRIVER:'resend', EMAIL_API_KEY:'SEGREDO_NAO_LOGAR', EMAIL_FROM:'GOATSKINS <no-reply@goatskins.test>', ...extra };
  const logs = [], sandbox = { module:{exports:{}}, require:n=>n==='./config'?cfg:require(n), fetch, AbortSignal,
    console:{ log:s=>logs.push(s), error:s=>logs.push(s) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/mail.js'),'utf8'),sandbox);
  return {...sandbox.module.exports,logs};
}
test('Resend: aguarda aceitação, valida ID e não anuncia entrega',async()=>{
  let request;
  const m=carregar(async(url,options)=>{request={url,options};return {ok:true,json:async()=>({id:'id-teste'})};});
  const r=await m.enviarObrigatorio('u@teste.com','Assunto','Texto');
  assert.equal(r.simulado,false);assert.equal(r.id,'id-teste');
  assert.equal(request.url,'https://api.resend.com/emails');assert.equal(request.options.headers.Authorization,'Bearer SEGREDO_NAO_LOGAR');
  assert.match(m.logs[0],/aceito/);assert.ok(!m.logs.join('').includes('SEGREDO_NAO_LOGAR'));
});
test('Resend: 401, 403, 429 e 500 propagam falha sem expor corpo ou credenciais',async()=>{
  for(const status of [401,403,429,500]) {
    const m=carregar(async()=>({ok:false,status,json:async()=>({name:'validation_error',message:'SEGREDO_NAO_LOGAR'})}));
    await assert.rejects(m.enviarObrigatorio('u@teste.com','x','codigo 123456'),new RegExp('HTTP_'+status));
    assert.equal(await m.enviar('u@teste.com','x','texto'),null);
    assert.ok(!m.logs.join('').includes('SEGREDO_NAO_LOGAR'));assert.ok(!m.logs.join('').includes('123456'));
  }
});
test('Resend: timeout, rede e sucesso sem ID não são tratados como sucesso',async()=>{
  await assert.rejects(carregar(async()=>{throw new Error('secret');}).enviarObrigatorio('a','b','c'),/TIMEOUT/);
  await assert.rejects(carregar(async()=>({ok:true,json:async()=>({})})).enviarObrigatorio('a','b','c'),/RESPOSTA_INVALIDA/);
});

test('Resend: recuperação preserva remetente e Idempotency-Key entre retentativas',async()=>{
  const requests=[];
  const m=carregar(async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({id:'id-retry'})};});
  const opts={from:'GOATSKINS <recovery@goatskins.test>',idempotencyKey:'password-recovery/fixture'};
  for(let n=0;n<2;n++)await m.enviarObrigatorio('fixture@goatskins.test','Recuperação','Mesmo texto',opts);
  assert.equal(requests[0].options.headers['Idempotency-Key'],opts.idempotencyKey);
  assert.equal(JSON.parse(requests[0].options.body).from,opts.from);
  assert.equal(requests[0].options.body,requests[1].options.body);
  assert.equal(requests[1].options.headers['Idempotency-Key'],opts.idempotencyKey);
});
test('console nunca envia em produção; driver desconhecido não cai em simulação',async()=>{
  for(const extra of [{EMAIL_DRIVER:'console',PRODUCAO:true},{EMAIL_DRIVER:'typo'}])
    await assert.rejects(carregar(()=>{throw Error('não deveria chamar');},extra).enviarObrigatorio('a','b','c'),/DRIVER_INVALIDO/);
});
