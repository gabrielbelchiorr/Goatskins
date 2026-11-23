/* Native CDP, actual Chromium + HTTP + disposable PostgreSQL; no browser package required.
   Browser uses a temporary profile and permits page requests only to the local fixture app. */
const {test}=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const database=require('../scripts/banco-teste').bancoTeste(process.env.TEST_DATABASE_URL);
const cleanEnv=require('./helpers/ambiente-teste');
const {freePort}=require('./helpers/free-port');
const executable=[process.env.SECURITY_AUDIT_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&fs.existsSync(p));
const payload=n=>'<svg/onload=window.__auditXss='+n+'>';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,message){for(let i=0;i<180;i++){if(await fn())return;await delay(50);}assert.fail(message);}
async function stop(child){if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}

class CDP{
  constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();this.listeners=new Map();
    ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.id){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}
      else for(const fn of this.listeners.get(m.method)||[])Promise.resolve(fn(m.params)).catch(e=>{this.error=e;});});}
  static async connect(url){const ws=new WebSocket(url);await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true});});return new CDP(ws);}
  on(method,fn){this.listeners.set(method,[...(this.listeners.get(method)||[]),fn]);}
  send(method,params={}){if(this.error)return Promise.reject(this.error);const id=++this.seq;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+': '+JSON.stringify(r.exceptionDetails.exception));return r.result.value;}
  close(){this.ws.close();for(const p of this.pending.values())p.reject(Error('CDP closed'));this.pending.clear();}
}
function totp(secret){let bits=0,value=0;const bytes=[];for(const c of secret){value=(value<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}
  const ctr=Buffer.alloc(8);ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const h=crypto.createHmac('sha1',Buffer.from(bytes)).update(ctr).digest(),offset=h[19]&15;return String((h.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}

test('Browser security: stored, URL and DOM payloads remain text across public, account, finance, admin and roulette screens',
  {skip:!database?'Requires dedicated TEST_DATABASE_URL':!executable?'Requires local Chromium (SECURITY_AUDIT_BROWSER)':false,timeout:90000},async()=>{
  const schema='rigorous_frontend_'+crypto.randomBytes(10).toString('hex');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'goatskins-security-browser-'));
  let app,browser,cdp,pool,base,adminCookie='',userCookie='';
  const seen=[],external=[],exceptions=[],checks=[];
  const original=new(require('pg').Pool)({connectionString:database});
  await original.query('CREATE SCHEMA '+schema);await original.end();
  const scoped=new URL(database);scoped.searchParams.set('options','-c search_path='+schema);
  pool=new(require('pg').Pool)({connectionString:scoped.toString(),statement_timeout:10000});
  async function api(method,url,body,cookie){const r=await fetch(base+url,{method,signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','X-Requested-With':'goatskins',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await r.json();assert.equal(r.status,200,url+': '+JSON.stringify(result));return {data:result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  async function inspect(label,selector,expected){
    await until(()=>cdp.evaluate('Boolean(document.querySelector('+JSON.stringify(selector)+'))'),label+' did not render');
    const value=await cdp.evaluate(`({text:document.querySelector(${JSON.stringify(selector)}).textContent,
      executed:typeof window.__auditXss!=='undefined',polluted:Object.prototype.auditPolluted!==undefined,
      injected:[...document.querySelectorAll('[onload],[onerror],script[src="x"],iframe')].map(e=>e.outerHTML)})`);
    assert(value.text.includes(expected),label+' must display the original payload as text');
    assert.equal(value.executed,false,label+' executed payload');assert.equal(value.polluted,false,label+' polluted Object.prototype');assert.deepEqual(value.injected,[],label+' created injected elements');checks.push(label);
  }
  try{
    const port=await freePort();base='http://127.0.0.1:'+port;
    app=spawn(process.execPath,['--no-warnings','server.js'],{stdio:'ignore',env:{...process.env,...cleanEnv,TESTE:'',DATABASE_URL:scoped.toString(),PORT:String(port),APP_URL:base,DATA_DIR:root,MP_API_BASE:'http://127.0.0.1:9'}});
    await until(async()=>{assert.equal(app.exitCode,null,'Fixture app exited');try{return(await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'Fixture app unavailable');
    const password='BrowserFixture123',salt=crypto.randomBytes(16).toString('hex'),hash=salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
    const accounts={};
    for(const [key,role]of [['admin','SUPER_ADMIN'],['user','USER']]){
      const email=key+'-'+crypto.randomBytes(8).toString('hex')+'@goatskins.test';
      const id=Number((await pool.query("INSERT INTO users(nome,contato,email,hash,role,email_verificado,telefone) VALUES('Browser fixture',$1,$1,$2,$3,1,'+5511999999999') RETURNING id",[email,hash,role])).rows[0].id);
      accounts[key]={id,email};const login=await api('POST','/api/login',{email,senha:password});if(key==='admin')adminCookie=login.cookie;else userCookie=login.cookie;
    }
    const prepared=await api('POST','/api/mfa/preparar',{senha:password},adminCookie);
    const verified=await api('POST','/api/mfa/verificar',{senha:password,codigo:totp(prepared.data.secret),codigoEmail:[...require("node:fs").readFileSync(require("node:path").join(root,"emails.log"),"utf8").matchAll(/Código de ativação: (\d{6})/g)].pop()[1]},adminCookie);adminCookie=verified.cookie;
    await api('PUT','/api/conta',{nome:payload(10),telefone:'+5511999999999'},userCookie);
    const visual={titulo:payload(11),sub:payload(12),banner:'',cores:{gold:'#d4aa55',copper:'#b8651f',slate:'#102440',navy:'#0e1a33'}};
    Object.defineProperty(visual,'__proto__',{value:{auditPolluted:true},enumerable:true});visual.constructor={prototype:{auditPolluted:true}};
    await api('PUT','/api/admin/visual',visual,adminCookie);
    const stored=JSON.parse((await pool.query("SELECT v FROM settings WHERE k='visual'")).rows[0].v);
    assert.equal(Object.hasOwn(stored,'__proto__'),false);assert.equal(Object.hasOwn(stored,'constructor'),false);assert.equal({}.auditPolluted,undefined);
    const campaigns=[];
    for(const n of [20,30]){await api('POST','/api/admin/campanhas',{premio:payload(n),desgaste:payload(n+1),descricao:payload(n+2),valor:100,cor:'#b3263a',max:n===20?2:1,max_por_usuario:1,preco_numero:0},adminCookie);campaigns.push(Number((await pool.query('SELECT id FROM campaigns WHERE premio=$1',[payload(n)])).rows[0].id));}
    const [openId,drawnId]=campaigns;assert(Number.isSafeInteger(openId)&&Number.isSafeInteger(drawnId));
    await pool.query("INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES($1,$2,1,'')",[drawnId,accounts.user.id]);
    await api('POST','/api/admin/campanhas/'+drawnId+'/sortear',{},adminCookie);
    await pool.query("INSERT INTO notifications(user_id,titulo,texto,criado_em) VALUES($1,$2,$3,$4)",[accounts.user.id,payload(40),payload(41),new Date().toISOString()]);
    const ref=crypto.randomBytes(16).toString('hex');
    await pool.query("INSERT INTO pedidos(public_id,user_id,campaign_id,numeros,total_centavos,status,mp_order_id,expira_em,criado_em,atualizado_em) VALUES($1,$2,$3,'[2]',100,'REFUND_NEEDED',$4,$5,$6,$6)",[ref,accounts.user.id,openId,'ORD'+crypto.randomBytes(12).toString('hex').toUpperCase(),Date.now()+600000,new Date().toISOString()]);
    await pool.query("INSERT INTO audit_logs(quando,user_id,acao,detalhe,ip) VALUES($1,$2,'BROWSER_FIXTURE',$3,'127.0.0.1')",[new Date().toISOString(),accounts.user.id,payload(42)]);

    const debugPort=await freePort();
    browser=spawn(executable,['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort,
      '--user-data-dir='+path.join(root,'browser-profile'),'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps','--disable-extensions','--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','about:blank'],{stdio:'ignore',windowsHide:true});
    let target;await until(async()=>{assert.equal(browser.exitCode,null,'Chromium exited');try{const pages=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();target=pages.find(p=>p.type==='page');return !!target;}catch{return false;}},'Chromium remote debugging unavailable');
    cdp=await CDP.connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown',e=>exceptions.push(e.exceptionDetails.text));
    cdp.on('Fetch.requestPaused',async e=>{
      const url=new URL(e.request.url);seen.push(url.origin+url.pathname);
      if(url.origin!==base){external.push(url.origin);return cdp.send('Fetch.failRequest',{requestId:e.requestId,errorReason:'BlockedByClient'});}
      if(url.pathname==='/audit-positive-control')return cdp.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from('<!doctype html><img src="/control-missing" onerror="window.__auditXss=1">').toString('base64')});
      return cdp.send('Fetch.continueRequest',{requestId:e.requestId});
    });
    await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
    const version=await cdp.send('Browser.getVersion');
    await cdp.send('Page.navigate',{url:base+'/audit-positive-control'});
    await until(()=>cdp.evaluate('window.__auditXss===1'),'Browser positive XSS control did not execute');
    assert.equal(await cdp.evaluate('document.querySelectorAll("[onerror]").length'),1);checks.push('Executable XSS positive control');
    await cdp.send('Page.navigate',{url:base+'/?msg='+encodeURIComponent(payload(50))+'&sorteio='+openId+'#'+encodeURIComponent(payload(51))});
    await until(()=>cdp.evaluate('Boolean(document.querySelector("#saleDetail h1"))'),'Public detail unavailable');
    await inspect('Stored appearance title','#heroTitle',payload(11));await inspect('Stored appearance subtitle','#heroSub',payload(12));
    await inspect('Public campaign detail','#saleDetail',payload(22));
    await inspect('Public campaign card','#gridAtivos',payload(20));await inspect('Public history','#histList',payload(10));
    assert.equal(await cdp.evaluate('new URL(location.href).searchParams.has("msg")'),false);checks.push('URL query/hash payload cannot create DOM');
    await cdp.send('Network.setCookie',{name:'sid',value:userCookie.slice(4),url:base,httpOnly:true,sameSite:'Lax'});
    await cdp.send('Page.navigate',{url:base});await until(()=>cdp.evaluate('document.querySelector("#contaBtn")?.hidden===false'),'Authenticated UI unavailable');
    await cdp.evaluate('conta()');await inspect('Account identity','#modalBody',payload(10));await inspect('Account notifications','#modalBody',payload(41));
    await cdp.evaluate('closeModal(); carregarPedidos()');await inspect('User payment history','#pedList',payload(20));
    await cdp.evaluate('roleta(S.c.find(c=>c.ganhador))');await inspect('Roulette winner','.roulette-winner-name',payload(10));await inspect('Roulette prize','.roulette-prize',payload(30));
    await cdp.evaluate('document.querySelector("dialog.roulette-screen").close()');
    await cdp.send('Network.setCookie',{name:'sid',value:adminCookie.slice(4),url:base,httpOnly:true,sameSite:'Lax'});
    await cdp.send('Page.navigate',{url:base});await until(()=>cdp.evaluate('document.querySelector("#adminBtn")?.hidden===false'),'Admin UI unavailable');
    for(const [tab,text]of [['painel',payload(20)],['usuarios',payload(10)],['logs',payload(42)],['pedidos',payload(20)],['entregas',payload(10)],['sorteios',payload(20)],['visual',payload(11)]]){
      await cdp.evaluate('painel('+JSON.stringify(tab)+')');
      await until(()=>cdp.evaluate('document.querySelector("#modalBody")?.textContent.includes('+JSON.stringify(tab==='visual'?'Título do topo':text)+')'),'Admin '+tab+' did not load');
      if(tab==='visual')assert.equal(await cdp.evaluate('document.querySelector("#modalBody input[type=text]").value'),text);
      else await inspect('Admin '+tab,'#modalBody',text);
    }
    await cdp.evaluate(`localStorage.setItem('goatskins-cookies',JSON.stringify({version:1,preferences:true,...JSON.parse('{"__proto__":{"auditPolluted":true}}')}))`);
    await cdp.send('Page.navigate',{url:base});await until(()=>cdp.evaluate('Boolean(document.querySelector("#gridAtivos .card"))'),'Reload unavailable');
    assert.equal(await cdp.evaluate('Object.prototype.auditPolluted===undefined'),true);checks.push('Untrusted JSON keys do not pollute prototypes');
    assert.equal(await cdp.evaluate('window.__auditXss===undefined'),true);assert.deepEqual(external,[]);assert.deepEqual(exceptions,[]);assert(seen.some(url=>url.includes('/api/admin/usuarios')));assert(seen.some(url=>url.includes('/api/admin/pedidos')));
    const output=process.env.SECURITY_AUDIT_OUTPUT||path.resolve(__dirname,'../validation/security-audit');fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'browser-security.json'),JSON.stringify({browser:version.product,protocol:version.protocolVersion,checks,externalRequestsBlocked:external.length,javascriptExceptions:exceptions.length,productionCodeChanged:false},null,2)+'\n');
  }finally{
    if(cdp)cdp.close();await stop(browser);await stop(app);
    if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^goatskins-security-browser-/);fs.rmSync(root,{recursive:true,force:true});
  }
});
