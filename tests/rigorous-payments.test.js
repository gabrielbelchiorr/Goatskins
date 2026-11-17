/* Real HTTP + PostgreSQL + loopback Orders API. No real provider request or charge. */
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto'), http = require('node:http');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const database = require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const cleanEnv = require('./helpers/ambiente-teste');
const { freePort } = require('./helpers/free-port');
const schema = 'rigorous_payments_' + crypto.randomBytes(10).toString('hex');
const secret = crypto.randomBytes(32).toString('hex');
const options = {skip:!database, timeout:30000};
const orders = new Map(), creations = new Map(), calls = [];
let pool, provider, app, base, dataDir, providerMode = 'normal', cancelMode = 'normal';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function pending(id, ref, total) {
  return {id, external_reference:ref, status:'action_required', status_detail:'waiting_transfer',
    currency_id:'BRL', total_amount:(total/100).toFixed(2),
    transactions:{payments:[{id:'PAY'+id.slice(3), status:'action_required',
      payment_method:{id:'pix',type:'bank_transfer',qr_code:'000201-fixture-only'}}]}};
}
function paid(order) {
  return {...order,status:'processed',status_detail:'accredited',total_paid_amount:order.total_amount,
    transactions:{payments:[{...order.transactions.payments[0],status:'processed',status_detail:'accredited',paid_amount:order.total_amount}]}};
}
function signature(id, requestId='fixture-request', timestamp=String(Date.now()), key=secret) {
  return 'ts='+timestamp+',v1='+crypto.createHmac('sha256',key)
    .update('id:'+id.toLowerCase()+';request-id:'+requestId+';ts:'+timestamp+';').digest('hex');
}
async function request(method, pathname, body, headers={}) {
  const r = await fetch(base+pathname,{method,redirect:'manual',signal:AbortSignal.timeout(20000),
    headers:{'Content-Type':'application/json','X-Requested-With':'goatskins',...headers},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
}
function webhook(p, {headers={},body={},query=true}={}) {
  return request('POST','/api/webhooks/mercadopago'+(query?'?type=order&data.id='+p.orderId:''),body,
    {'x-request-id':'fixture-request','x-signature':signature(p.orderId),...headers});
}
async function fixture({nums=[1,2],reserve=true,status='PENDING',campaignId,userId}={}) {
  const ref=crypto.randomBytes(16).toString('hex'), orderId='ORD'+crypto.randomBytes(12).toString('hex').toUpperCase();
  let token;
  if (!userId) {
    const email=ref+'@goatskins.test';
    userId=Number((await pool.query("INSERT INTO users(nome,contato,email,hash,email_verificado,telefone) VALUES('Local payment fixture',$1,$1,'unused',1,'+5511999999999') RETURNING id",[email])).rows[0].id);
  }
  token=crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions(token,user_id,expira) VALUES($1,$2,$3)',[sha(token),userId,Date.now()+600000]);
  if (!campaignId) campaignId=Number((await pool.query("INSERT INTO campaigns(premio,fim,max,max_por_usuario,preco_centavos) VALUES('Local payment fixture','',10,10,175) RETURNING id")).rows[0].id);
  const total=175*nums.length;
  const id=Number((await pool.query('INSERT INTO pedidos(public_id,user_id,campaign_id,numeros,total_centavos,status,mp_order_id,expira_em,criado_em,atualizado_em) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id',
    [ref,userId,campaignId,JSON.stringify(nums),total,status,orderId,Date.now()+600000,new Date().toISOString()])).rows[0].id);
  if(reserve)for(const n of nums)await pool.query('INSERT INTO reservas(campaign_id,n,pedido_id) VALUES($1,$2,$3)',[campaignId,n,id]);
  orders.set(orderId,pending(orderId,ref,total));
  return {id,ref,orderId,userId,campaignId,nums,total,cookie:'sid='+token};
}
async function state(p) {
  const r=await pool.query(`SELECT p.status,p.mp_creation_uncertain,
    (SELECT COUNT(*)::int FROM tickets WHERE campaign_id=p.campaign_id AND user_id=p.user_id) tickets,
    (SELECT COUNT(*)::int FROM reservas WHERE pedido_id=p.id) reserves,
    (SELECT COUNT(*)::int FROM audit_logs WHERE acao='PAGAMENTO_CONFIRMADO' AND detalhe LIKE 'pedido '||p.id||' números %') confirmations
    FROM pedidos p WHERE p.id=$1`,[p.id]);
  return r.rows[0];
}
async function waitFor(check, message) {
  for(let i=0;i<120;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.fail(message);
}

before(async()=>{
  if(!database)return;
  pool=new(require('pg').Pool)({connectionString:database,statement_timeout:10000});
  await pool.query('CREATE SCHEMA '+schema);
  await pool.end();
  const scoped=new URL(database);scoped.searchParams.set('options','-c search_path='+schema);
  pool=new(require('pg').Pool)({connectionString:scoped.toString(),statement_timeout:10000});
  provider=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
      const key=req.headers['x-idempotency-key'];calls.push({method:req.method,url:req.url,key,body});
      assert.equal(req.headers.authorization,'Bearer local-fixture-token');
      let result, code=200;
      if(req.method==='POST'&&req.url==='/v1/orders'){
        result=creations.get(key);
        if(!result){result=pending('ORD'+crypto.randomBytes(12).toString('hex').toUpperCase(),body.external_reference,Math.round(Number(body.total_amount)*100));creations.set(key,result);orders.set(result.id,result);}
        if(providerMode==='ambiguous'){code=503;providerMode='normal';}
      }else{
        const match=req.url.match(/^\/v1\/orders\/(ORD[A-Za-z0-9]+)(\/cancel)?$/);
        if(!match||!orders.has(match[1])){code=404;result={};}
        else if(match[2]){
          result=orders.get(match[1]);
          if(cancelMode==='offline')code=503;
          else {result={...result,status:'canceled',transactions:{payments:[{status:'canceled'}]}};orders.set(result.id,result);}
        }else{result=orders.get(match[1]);if(result===null)code=503;}
      }
      res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end('{}');}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'goatskins-rigorous-payments-'));
  const port=await freePort();base='http://127.0.0.1:'+port;
  app=spawn(process.execPath,['--no-warnings','server.js'],{stdio:['ignore','ignore','pipe'],env:{...process.env,...cleanEnv,
    NODE_ENV:'test',TESTE:'',DATABASE_URL:scoped.toString(),PORT:String(port),APP_URL:base,DATA_DIR:dataDir,
    MP_ACCESS_TOKEN:'local-fixture-token',MP_WEBHOOK_SECRET:secret,MP_API_BASE:'http://127.0.0.1:'+provider.address().port}});
  let errors='';app.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-2000);});
  await waitFor(async()=>{
    assert.equal(app.exitCode,null,'Isolated server exited: '+errors);
    try{return(await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}
  },'Isolated server did not become ready');
});
after(async()=>{
  if(app&&app.exitCode===null&&app.signalCode===null)await new Promise(resolve=>{app.once('exit',resolve);app.kill();});
  if(provider)await new Promise(resolve=>provider.close(resolve));
  if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}
  if(dataDir){assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));assert.match(path.basename(dataDir),/^goatskins-rigorous-payments-/);fs.rmSync(dataDir,{recursive:true,force:true});}
});

test('Payments HTTP: missing, forged, stale and altered signatures never consult the provider or change SQL state',options,async()=>{
  const p=await fixture(), initial=await state(p), count=calls.length;
  const variants=[{'x-signature':''},{'x-signature':signature(p.orderId,'fixture-request',String(Date.now()),'wrong-secret')},
    {'x-signature':signature(p.orderId,'fixture-request',String(Date.now()-3600000))},
    {'x-request-id':'altered-request'}, {'x-signature':signature('ORDOTHER00000000000000000')}];
  for(const headers of variants){const r=await webhook(p,{headers,body:{status:'processed',total_paid_amount:'9999.00'}});assert.equal(r.status,401);assert.deepEqual(await state(p),initial);}
  assert.equal(calls.length,count);
});

test('Payments HTTP: server refuses manipulated amount, reference, order, currency and method with reservations intact',options,async()=>{
  const p=await fixture(), good=paid(orders.get(p.orderId)), initial=await state(p);
  const variants=[{total_paid_amount:'0.01'},{total_paid_amount:'3.5e0'},{total_paid_amount:'-3.50'},
    {total_paid_amount:null},{total_amount:undefined},{total_amount:'0.01'},{currency_id:'USD'},
    {external_reference:'b'.repeat(32)},{id:'ORDOTHER00000000000000000'},
    {transactions:{payments:[{...good.transactions.payments[0],payment_method:{id:'credit_card'}}]}}];
  for(const variant of variants){orders.set(p.orderId,{...good,...variant});assert.equal((await webhook(p)).status,200);assert.deepEqual(await state(p),initial);}
});

test('Payments HTTP: provider outage returns retryable failure; parallel signed replays grant entries exactly once',options,async()=>{
  const p=await fixture(),good=paid(orders.get(p.orderId)),initial=await state(p);
  orders.set(p.orderId,null);assert.equal((await webhook(p)).status,502);assert.deepEqual(await state(p),initial);
  orders.set(p.orderId,good);
  const responses=await Promise.all(Array.from({length:12},()=>webhook(p)));
  assert(responses.every(r=>r.status===200));
  assert.deepEqual(await state(p),{status:'PAID',mp_creation_uncertain:0,tickets:2,reserves:0,confirmations:1});
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND titulo='Pagamento confirmado!'",[p.userId])).rows[0].n,1);
});

test('Payments HTTP: signed query ID takes precedence over unsigned body ID; body-only signed notifications work',options,async()=>{
  const a=await fixture(),b=await fixture();orders.set(a.orderId,paid(orders.get(a.orderId)));orders.set(b.orderId,paid(orders.get(b.orderId)));
  assert.equal((await webhook(a,{body:{type:'order',data:{id:b.orderId},status:'processed'}})).status,200);
  assert.equal((await state(a)).status,'PAID');assert.equal((await state(b)).status,'PENDING');
  assert.equal((await webhook(b,{query:false,body:{type:'order',data:{id:b.orderId}}})).status,200);
  assert.equal((await state(b)).status,'PAID');
});

test('Payments HTTP: early signed webhook recovers an uncertain order before its provider ID is persisted',options,async()=>{
  const p=await fixture(),good=paid(orders.get(p.orderId));
  await pool.query('UPDATE pedidos SET mp_order_id=NULL,mp_creation_uncertain=1 WHERE id=$1',[p.id]);
  orders.set(p.orderId,good);assert.equal((await webhook(p)).status,200);
  assert.equal((await pool.query('SELECT mp_order_id FROM pedidos WHERE id=$1',[p.id])).rows[0].mp_order_id,p.orderId);
  assert.deepEqual(await state(p),{status:'PAID',mp_creation_uncertain:1,tickets:2,reserves:0,confirmations:1});
  assert.equal((await webhook(p)).status,200);assert.equal((await state(p)).confirmations,1);
});

test('Payments HTTP: another account cannot list, recover, read or refresh a foreign payment; client status cannot grant entries',options,async()=>{
  const a=await fixture(),b=await fixture(),initial=await state(a),count=calls.length;
  const foreign='/api/pedidos/'+a.ref;
  assert.equal((await request('GET',foreign,undefined,{Cookie:b.cookie})).status,404);
  assert.equal((await request('POST',foreign+'/atualizar',{status:'PAID',user_id:a.userId},{Cookie:b.cookie})).status,404);
  const listed=await request('GET','/api/pedidos',undefined,{Cookie:b.cookie});assert.equal(listed.status,200);
  assert(listed.body.every(p=>p.id!==a.ref));
  const recovered=await request('GET','/api/pedidos/pendente',undefined,{Cookie:b.cookie});assert.equal(recovered.status,200);
  assert(recovered.body===null||recovered.body.id!==a.ref);
  assert.equal(calls.length,count);assert.deepEqual(await state(a),initial);
  const own=await request('POST',foreign+'/atualizar',{status:'PAID',total_paid_amount:9999},{Cookie:a.cookie});
  assert.equal(own.status,200);assert.equal(own.body.status,'PENDING');assert.deepEqual(await state(a),initial);
});

test('Payments HTTP: checkout ignores mass assignment and prices/idempotency come from SQL',options,async()=>{
  const p=await fixture({nums:[10]}),before=calls.length;
  const body={numeros:[3,4],total:0.01,total_centavos:1,status:'PAID',user_id:p.userId+99999,public_id:'f'.repeat(32),mp_order_id:'ORDATTACKER000000000000'};
  const pathname='/api/campanhas/'+p.campaignId+'/pedidos';
  const first=await request('POST',pathname,body,{Cookie:p.cookie});assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal(first.body.total,3.5);assert.equal(first.body.status,'PENDING');assert.notEqual(first.body.id,body.public_id);
  const second=await request('POST',pathname,body,{Cookie:p.cookie});assert.equal(second.status,200);assert.equal(second.body.id,first.body.id);
  const created=calls.slice(before).filter(c=>c.method==='POST'&&c.url==='/v1/orders');assert.equal(created.length,1);
  assert.equal(created[0].key,first.body.id);assert.equal(created[0].body.external_reference,first.body.id);
  assert.equal(created[0].body.total_amount,'3.50');assert.equal(created[0].body.transactions.payments[0].amount,'3.50');
  const row=(await pool.query('SELECT user_id,status,total_centavos FROM pedidos WHERE public_id=$1',[first.body.id])).rows[0];
  assert.equal(Number(row.user_id),p.userId);assert.equal(row.status,'PENDING');assert.equal(row.total_centavos,350);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM reservas r JOIN pedidos p ON p.id=r.pedido_id WHERE p.public_id=$1',[first.body.id])).rows[0].n,2);
});

test('Payments HTTP: simultaneous checkouts for the same number produce one reservation and one provider order',options,async()=>{
  const a=await fixture({nums:[9]}),b=await fixture({nums:[10],campaignId:a.campaignId}),before=calls.length;
  const pathname='/api/campanhas/'+a.campaignId+'/pedidos';
  const results=await Promise.all([a,b].map(p=>request('POST',pathname,{numeros:[3]},{Cookie:p.cookie})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM reservas WHERE campaign_id=$1 AND n=3',[a.campaignId])).rows[0].n,1);
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM pedidos WHERE campaign_id=$1 AND numeros='[3]'",[a.campaignId])).rows[0].n,1);
  assert.equal(calls.slice(before).filter(c=>c.method==='POST'&&c.url==='/v1/orders').length,1);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM tickets WHERE campaign_id=$1',[a.campaignId])).rows[0].n,0);
});

test('Payments HTTP: ambiguous creation retries original idempotency key; uncertain cancellation cannot free payable numbers',options,async()=>{
  const p=await fixture({nums:[10]}),pathname='/api/campanhas/'+p.campaignId+'/pedidos';
  providerMode='ambiguous';
  const result=await request('POST',pathname,{numeros:[3]},{Cookie:p.cookie});assert.equal(result.status,502);
  const row=(await pool.query("SELECT id,public_id FROM pedidos WHERE campaign_id=$1 AND numeros='[3]'",[p.campaignId])).rows[0];
  const uncertain={id:Number(row.id)},ref=row.public_id;
  assert.deepEqual(await state(uncertain),{status:'PENDING',mp_creation_uncertain:1,tickets:0,reserves:1,confirmations:0});
  const remote=creations.get(ref);assert(remote,'Mock accepted original creation before simulated transport failure');
  await pool.query('UPDATE pedidos SET criado_em=$1 WHERE id=$2',[new Date(Date.now()-30000).toISOString(),row.id]);
  await request('GET','/api/pedidos',undefined,{Cookie:p.cookie});
  await waitFor(async()=>(await state(uncertain)).mp_creation_uncertain===0,'Creation was not reconciled');
  assert.equal((await pool.query('SELECT mp_order_id FROM pedidos WHERE id=$1',[row.id])).rows[0].mp_order_id,remote.id);
  assert.equal(calls.filter(c=>c.url==='/v1/orders'&&c.key===ref).length,2);assert.equal(creations.get(ref).id,remote.id);
  cancelMode='offline';await pool.query('UPDATE pedidos SET expira_em=$1 WHERE id=$2',[Date.now()-1000,row.id]);
  await request('GET','/api/pedidos',undefined,{Cookie:p.cookie});
  await waitFor(async()=>calls.some(c=>c.url==='/v1/orders/'+remote.id+'/cancel'),'Mock cancellation was not attempted');
  assert.deepEqual(await state(uncertain),{status:'PENDING',mp_creation_uncertain:0,tickets:0,reserves:1,confirmations:0});
  cancelMode='normal';
  await new Promise(resolve=>setTimeout(resolve,60));
  await request('GET','/api/pedidos',undefined,{Cookie:p.cookie});
  await waitFor(async()=>(await state(uncertain)).status==='EXPIRED','Confirmed cancellation was not applied');
  assert.deepEqual(await state(uncertain),{status:'EXPIRED',mp_creation_uncertain:0,tickets:0,reserves:0,confirmations:0});
});

test('Payments HTTP: late payment for an occupied number records refund obligation; terminal refunds cannot grant tickets',options,async()=>{
  const p=await fixture({status:'EXPIRED',reserve:false}),other=await fixture({nums:[9]});
  await pool.query("INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES($1,$2,$3,'')",[p.campaignId,other.userId,p.nums[0]]);
  orders.set(p.orderId,paid(orders.get(p.orderId)));assert.equal((await webhook(p)).status,200);
  assert.deepEqual(await state(p),{status:'REFUND_NEEDED',mp_creation_uncertain:0,tickets:0,reserves:0,confirmations:0});
  assert.equal(Number((await pool.query('SELECT user_id FROM tickets WHERE campaign_id=$1 AND n=$2',[p.campaignId,p.nums[0]])).rows[0].user_id),other.userId);
  await pool.query("UPDATE pedidos SET status='REFUNDED' WHERE id=$1",[p.id]);
  assert.equal((await webhook(p)).status,200);assert.equal((await state(p)).status,'REFUNDED');assert.equal((await state(p)).tickets,0);
});

test('Payments HTTP: refund/chargeback after confirmation is flagged once and keeps the confirmed entries',options,async()=>{
  const p=await fixture(),good=paid(orders.get(p.orderId));
  orders.set(p.orderId,good);assert.equal((await webhook(p)).status,200);
  const confirmed=await state(p);assert.equal(confirmed.status,'PAID');assert.equal(confirmed.tickets,p.nums.length);
  // Outra Order com o mesmo status não pode marcar este pedido.
  orders.set(p.orderId,{...good,id:'ORDOTHER00000000000000000',status:'charged_back'});assert.equal((await webhook(p)).status,200);
  assert.equal((await pool.query('SELECT mp_status FROM pedidos WHERE id=$1',[p.id])).rows[0].mp_status,'processed');
  orders.set(p.orderId,{...good,status:'charged_back'});
  for(let i=0;i<3;i++)assert.equal((await webhook(p)).status,200);
  const row=(await pool.query('SELECT status,mp_status FROM pedidos WHERE id=$1',[p.id])).rows[0];
  assert.deepEqual(row,{status:'PAID',mp_status:'charged_back'});
  assert.deepEqual(await state(p),confirmed,'entries are never removed automatically');
  const audits=(await pool.query("SELECT COUNT(*)::int n FROM audit_logs WHERE acao='PAGAMENTO_ESTORNADO_NO_MP' AND detalhe LIKE 'pedido '||$1||' %'",[p.id])).rows[0].n;
  assert.equal(audits,1,'one audit per state change, not per notification');
});

test('Share metadata: /?sorteio=ID describes the real campaign with escaped text; archived ones fall back',options,async()=>{
  const id=Number((await pool.query(`INSERT INTO campaigns(premio,desgaste,fim,max,max_por_usuario,preco_centavos) VALUES('AK "<b>x</b>"','FT','',10,2,350) RETURNING id`)).rows[0].id);
  const html=await (await fetch(base+'/?sorteio='+id)).text();
  assert.ok(html.includes('<link rel="canonical" href="'+base+'/?sorteio='+id+'">'));
  assert.match(html,/<meta property="og:title" content="Sorteio: AK &quot;&lt;b&gt;x&lt;\/b&gt;&quot; \| GOATSKINS">/);
  assert.match(html,/R\$ 3,50 por número\. 10 de 10 números disponíveis\./);
  assert.ok(!html.includes('<b>x</b>'));
  const sitemap=await (await fetch(base+'/sitemap.xml')).text();assert.ok(sitemap.includes('/?sorteio='+id+'</loc>'));
  await pool.query("UPDATE campaigns SET status='CLOSED', archived=1 WHERE id=$1",[id]);
  assert.ok((await (await fetch(base+'/?sorteio='+id)).text()).includes('<link rel="canonical" href="'+base+'/">'));
});
