/* Exercise the actual frontend in Chromium with deterministic intervals and local HTTP fixtures. */
const {test} = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const {startBrowser, executable, until} = require('./helpers/browser-cdp');
const cases = {skip:!executable && 'Requires local Chromium (SECURITY_AUDIT_BROWSER)', timeout:30000};
const campaign = {id:1,premio:'Local fixture',desgaste:'',descricao:'',valor:0,cor:'#b3263a',fim:'',max:10,max_por_usuario:2,foto:'',status:'OPEN',preco:2,reservados:[],ocupados:[],total:0,meus:[],ganhador:null};
const state = {eu:{id:1,nome:'Local fixture',role:'USER',email_verificado:1,celular_preenchido:true},naoLidas:0,s:{titulo:'GOATSKINS',sub:'Local fixture',banner:'',cores:{gold:'#d4aa55',copper:'#b8651f',slate:'#102440',navy:'#0e1a33'}},c:[campaign]};
const order = (id='a',status='PENDING') => ({id:id.repeat(32),campanha:1,premio:'Fixture '+id,numeros:[1],total:2,status,expira_em:Date.now()+300000,criado_em:new Date().toISOString(),pix:{qr_code:'LOCAL FIXTURE WITHOUT PAYMENT',qr_code_base64:null,ticket_url:null}});
const initialize = `
  localStorage.setItem('goatskins-cookies',JSON.stringify({version:1,preferences:false}));
  window.__intervals=new Map();window.__intervalSequence=0;window.__timerErrors=[];window.__hidden=false;
  Object.defineProperty(document,'hidden',{get:()=>window.__hidden});
  window.setInterval=(fn,ms)=>{const id=++window.__intervalSequence;window.__intervals.set(id,{fn,ms});return id;};
  window.clearInterval=id=>window.__intervals.delete(id);
  window.__runIntervals=ms=>Promise.all([...window.__intervals.values()].filter(t=>t.ms===ms).map(t=>Promise.resolve(t.fn()).catch(e=>window.__timerErrors.push(e.message))));
  window.__timerCount=ms=>[...window.__intervals.values()].filter(t=>ms===undefined||t.ms===ms).length;
`;
async function fixture(run) {
  const held = [], statusCalls = [];
  let hold = false;
  const browser = await startBrowser({directory:path.join(__dirname,'../public'),initialize,
    api:async(method,url) => {
      if (/^\/api\/pedidos\/[a-f0-9]{32}(?:\/atualizar)?$/.test(url)) {
        statusCalls.push({method,url});
        const data = order(url.split('/')[3][0]);
        return {data:hold?await new Promise(resolve=>held.push({resolve,data})):data};
      }
      return {data:url==='/api/estado'?state:url==='/api/pedidos/pendente'?null:[]};
    }});
  try {
    await browser.navigate();
    await run({...browser,statusCalls,holdStatus:()=>{hold=true;},
      release:(status='PENDING')=>{hold=false;for(const item of held.splice(0))item.resolve({...item.data,status});}});
    assert.deepEqual(browser.externalRequests,[]);assert.deepEqual(browser.pageErrors,[]);
    assert.deepEqual(await browser.cdp.evaluate('window.__timerErrors'),[]);
  } finally {for(const item of held)item.resolve(item.data);await browser.close();}
}
const open = (cdp, id='a', status='PENDING') => cdp.evaluate('pedidoModal('+JSON.stringify(order(id,status))+')');

test('Pix modal closes and replacement remove both timers immediately', cases, async()=>fixture(async({cdp})=>{
  assert.equal(await cdp.evaluate('__timerCount()'),2);
  await open(cdp);assert.equal(await cdp.evaluate('__timerCount(1000)'),2);assert.equal(await cdp.evaluate('__timerCount(10000)'),1);
  await cdp.evaluate('closeModal()');assert.equal(await cdp.evaluate('__timerCount()'),2);
  await open(cdp);await cdp.evaluate('aviso("Fixture", "Another modal")');assert.equal(await cdp.evaluate('__timerCount()'),2);
}));

test('Pix polling never overlaps requests and preserves alternating GET/POST reconciliation', cases, async()=>fixture(async({cdp,statusCalls,holdStatus,release})=>{
  await open(cdp);holdStatus();
  await cdp.evaluate('void __runIntervals(10000)');await until(()=>statusCalls.length===1);
  await cdp.evaluate('void __runIntervals(10000)');
  // A local event-loop turn is sufficient for a second overlapping fetch to reach the fixture server.
  await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,100))');assert.equal(statusCalls.length,1);
  release();await until(()=>cdp.evaluate('__timerCount(10000)===1'));
  await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,50))');await cdp.evaluate('__runIntervals(10000)');
  assert.deepEqual(statusCalls.map(c=>c.method),['GET','POST']);
}));

test('An old Pix response cannot stop or redraw the replacement modal', cases, async()=>fixture(async({cdp,statusCalls,holdStatus,release})=>{
  await open(cdp,'a');holdStatus();await cdp.evaluate('void __runIntervals(10000)');await until(()=>statusCalls.length===1);
  await open(cdp,'b');release('PAID');
  await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,100))');
  assert.equal(await cdp.evaluate('__timerCount(10000)'),1);assert.equal(await cdp.evaluate('__timerCount(1000)'),2);
  assert.equal(await cdp.evaluate('document.querySelector(".pix-detail strong").textContent'),'Fixture b');
  assert.equal(await cdp.evaluate('document.querySelector(".pix-success")===null'),true);
  await cdp.evaluate('__runIntervals(10000)');assert(statusCalls.at(-1).url.includes('b'.repeat(32)));
}));

test('A paid or canceled Pix screen does not start unnecessary polling timers', cases, async()=>fixture(async({cdp})=>{
  for(const status of ['PAID','CANCELED']){await open(cdp,'a',status);assert.equal(await cdp.evaluate('__timerCount()'),2);await cdp.evaluate('closeModal()');}
}));

test('Hidden tabs pause Pix requests and resume by visibility refresh', cases, async()=>fixture(async({cdp,requests,statusCalls})=>{
  await open(cdp);await until(()=>requests.filter(r=>r.pathname==='/api/pedidos/pendente').length>=2);
  const before=requests.filter(r=>r.pathname==='/api/pedidos/pendente').length;
  await cdp.evaluate('window.__hidden=true; __runIntervals(10000); __runIntervals(15000)');
  await cdp.evaluate('new Promise(resolve=>setTimeout(resolve,100))');
  assert.equal(statusCalls.length,0);assert.equal(requests.filter(r=>r.pathname==='/api/pedidos/pendente').length,before);
  await cdp.evaluate('window.__hidden=false;document.dispatchEvent(new Event("visibilitychange"))');
  await until(()=>requests.filter(r=>r.pathname==='/api/pedidos/pendente').length===before+1);
  await cdp.evaluate('__runIntervals(10000)');assert.equal(statusCalls.length,1);
}));
