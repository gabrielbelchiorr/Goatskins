/* Smoke explícito da Embed API pública. Sem banco nem pagamentos.
   node scripts/verificar-cs2inspect-live.js [--case weapon|knife|gloves] [--mobile]
   Lê somente CS2INSPECT_EMBED_KEY do ambiente/.env; não grava a chave nas evidências. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{freePort}=require('../tests/helpers/free-port'),{executable}=require('../tests/helpers/browser-cdp');
const {publicKey}=require('../public/cs2inspect');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const selected=process.argv[process.argv.indexOf('--case')+1]||'weapon',kind=process.argv.includes('--case')?selected:'weapon',mobile=process.argv.includes('--mobile');
const examples={weapon:{name:'AK-47 | Redline',wear:.18,seed:661},knife:{item:'karambit/doppler',wear:.03,seed:661},gloves:{item:'sport-gloves/vice',wear:.15,seed:1}};
class CDP {
 constructor(ws){this.ws=ws;this.sequence=0;this.pending=new Map();this.listeners=new Map();ws.addEventListener('message',event=>{const value=JSON.parse(String(event.data));if(value.id){const p=this.pending.get(value.id);if(!p)return;this.pending.delete(value.id);clearTimeout(p.timer);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);}else for(const listener of this.listeners.get(value.method)||[])listener(value.params,value.sessionId);});}
 on(method,fn){this.listeners.set(method,[...this.listeners.get(method)||[],fn]);}
 send(method,params={},sessionId,timeoutMs=10000){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout: '+method));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
 async evaluate(expression,sessionId,timeoutMs){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId,timeoutMs);if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}
 close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'));}this.pending.clear();this.ws.close();}
}
(async()=>{
 if(!Object.hasOwn(examples,kind))throw Error('Use --case weapon, knife ou gloves.');if(!executable)throw Error('Configure SECURITY_AUDIT_BROWSER para um Chromium local.');
 let key=process.env.CS2INSPECT_EMBED_KEY;
 if(!key){try{const line=fs.readFileSync(path.resolve(__dirname,'../.env'),'utf8').split(/\r?\n/).find(line=>/^\s*CS2INSPECT_EMBED_KEY\s*=/.test(line));key=line?.replace(/^\s*CS2INSPECT_EMBED_KEY\s*=\s*/,'').replace(/\s+#.*$/,'').replace(/^["']|["']$/g,'').trim();}catch(_){}}
 publicKey(key);
 const host=process.env.CS2INSPECT_TEST_HOST||'localhost';if(!['localhost','127.0.0.1'].includes(host))throw Error('O smoke aceita somente host local.');
 const mode=kind+(mobile?'-mobile':''),profile=fs.mkdtempSync(path.join(os.tmpdir(),'goatskins-cs2inspect-live-')),root=path.resolve(__dirname,'../public'),output=path.resolve(__dirname,'../validation');fs.mkdirSync(output,{recursive:true});
 const cleanUrl=raw=>{try{const url=new URL(raw);if(url.searchParams.has('key'))url.searchParams.set('key','[configured]');return url.href;}catch(_){return '';}};
 const report={checkedAt:new Date().toISOString(),mode,officialDocumentation:'https://cs2inspect.skin/docs/api',example:examples[kind],responses:[],networkErrors:[],consoleErrors:[]};let child,cdp;
 const server=http.createServer(async(req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; frame-src https://cs2inspect.skin; img-src 'self' data:"});return res.end('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GOATSKINS · teste CS2Inspect</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/skin-viewer.css"><body><button id="open">Abrir CS2Inspect</button><script src="/cs2inspect.js"></script><script src="/skin-viewer.js"></script><script src="/fixture.js"></script></body></html>');}
  if(pathname==='/fixture.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end('window.received=[];GoatSkinViewer.configure({key:'+JSON.stringify(key)+'});window.addEventListener("message",e=>{if(e.origin!=="https://cs2inspect.skin"||e.source!==document.querySelector("iframe")?.contentWindow||e.data?.source!=="cs2inspect-embed")return;let payload;try{const serialized=JSON.stringify(e.data,(name,value)=>name==="key"?"[configured]":value);payload=serialized.length<=4096?JSON.parse(serialized):{keys:Object.keys(e.data)};}catch(_){payload={keys:Object.keys(e.data)};}received.push({type:e.data.type,reason:e.data.reason,view:e.data.view,payload});});document.getElementById("open").onclick=()=>GoatSkinViewer.open({config:'+JSON.stringify(examples[kind])+',title:'+JSON.stringify((kind==='weapon'?'AK-47 | Redline':kind==='knife'?'Karambit | Doppler':'Sport Gloves | Vice')+' · teste oficial')+'});');}
  if(!['/style.css','/skin-viewer.css','/cs2inspect.js','/skin-viewer.js'].includes(pathname)){res.writeHead(404);return res.end();}try{const content=await fs.promises.readFile(path.join(root,pathname.slice(1)));res.writeHead(200,{'Content-Type':pathname.endsWith('.css')?'text/css':'text/javascript'});res.end(content);}catch(_){res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const debugPort=await freePort();child=spawn(executable,['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort,'--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps','--disable-extensions','--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication','about:blank'],{stdio:'ignore',windowsHide:true});
  let target;for(let i=0;i<150;i++){try{target=(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(t=>t.type==='page');if(target)break;}catch(_){}if(child.exitCode!==null)throw Error('Chromium encerrou antes de abrir.');await delay(100);}if(!target)throw Error('CDP indisponível.');
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});cdp=new CDP(ws);const sessions=new Set();
  const enable=async sessionId=>{await cdp.send('Runtime.enable',{},sessionId);await cdp.send('Network.enable',{},sessionId);};
  cdp.on('Target.attachedToTarget',event=>{if(event.targetInfo.type==='iframe'){sessions.add(event.sessionId);enable(event.sessionId).catch(()=>{});}});
  cdp.on('Target.detachedFromTarget',event=>sessions.delete(event.sessionId));
  cdp.on('Network.responseReceived',event=>{if(event.type==='Document')report.responses.push({url:cleanUrl(event.response.url),status:event.response.status});});
  cdp.on('Network.loadingFailed',event=>{if(!event.canceled)report.networkErrors.push({type:event.type,error:event.errorText,blockedReason:event.blockedReason});});cdp.on('Runtime.exceptionThrown',event=>report.consoleErrors.push(event.exceptionDetails.text));
  await enable();await cdp.send('Page.enable');await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});await cdp.send('Emulation.setDeviceMetricsOverride',{width:mobile?390:1440,height:mobile?844:1000,deviceScaleFactor:1,mobile});
  const base='http://'+host+':'+server.address().port;await cdp.send('Page.navigate',{url:base});for(let i=0;i<100;i++){if(await cdp.evaluate('typeof GoatSkinViewer!=="undefined"'))break;await delay(100);}
  report.framesBeforeClick=await cdp.evaluate('document.querySelectorAll("iframe").length');await cdp.evaluate('document.getElementById("open").click()');
  console.log('Aguardando o CS2Inspect: '+mode+' em '+host+'…');
  for(let i=0;i<150;i++){if(await cdp.evaluate('received.some(e=>e.type==="ready"||e.type==="error")'))break;await delay(200);}
  const refreshMessages=async()=>{
   report.local=await cdp.evaluate('({messages:received,status:document.querySelector(".skin-viewer-status")?.textContent})',undefined,1500);
   report.readyEvent=report.local.messages.find(e=>e.type==='ready')||null;report.ready=!!report.readyEvent;
   report.errors=report.local.messages.filter(e=>e.type==='error');report.error=report.errors[0]||null;
  };
  const observeProvider=async timeoutMs=>Promise.all([...sessions].map(async session=>{
   try{return await cdp.evaluate('({title:document.title,canvases:[...document.querySelectorAll("canvas")].map(c=>({width:c.width,height:c.height,visible:c.getBoundingClientRect().width>0&&c.getBoundingClientRect().height>0}))})',session,timeoutMs);}
   catch(error){return {inspectionError:error.message};}
  }));
  await refreshMessages();report.viewport=await cdp.evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth})');report.provider=[];
  // The ready event and the iframe's attachment can race. Wait for observable
  // canvas geometry, with a separate bounded deadline; pixels still need review.
  const renderStarted=Date.now(),renderDeadline=renderStarted+10000;
  do{
   report.provider=await observeProvider(Math.max(100,Math.min(1000,renderDeadline-Date.now())));
   report.canvasObserved=report.provider.some(p=>p.canvases?.some(c=>c.visible&&c.width>0&&c.height>0));
   await refreshMessages();
   if(report.error||report.canvasObserved||!report.ready)break;
   await delay(Math.min(200,Math.max(0,renderDeadline-Date.now())));
  }while(Date.now()<renderDeadline);
  report.renderObservationWaitMs=Date.now()-renderStarted;report.modelPixelsManuallyVerified=false;
  if(report.ready&&!report.error&&report.canvasObserved){
   const rect=await cdp.evaluate('(()=>{const r=document.querySelector("iframe").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()'),before=await cdp.send('Page.captureScreenshot',{format:'png'});
   await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});for(let step=1;step<=8;step++)await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+step*12,y:rect.y+step*3,buttons:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+96,y:rect.y+24,button:'left',clickCount:1});await delay(500);
   const rotated=await cdp.send('Page.captureScreenshot',{format:'png'});await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:rect.x,y:rect.y,deltaX:0,deltaY:-200});await delay(500);const zoomed=await cdp.send('Page.captureScreenshot',{format:'png'});report.controls={rotationPixelsChanged:before.data!==rotated.data,zoomPixelsChanged:rotated.data!==zoomed.data};
   const itemShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'cs2inspect-live-'+mode+'-item.png'),Buffer.from(itemShot.data,'base64'));report.itemScreenshot='cs2inspect-live-'+mode+'-item.png';
   await refreshMessages();
   if(kind!=='gloves'&&!report.error){
    const messageOffset=report.local.messages.length;
    await cdp.evaluate('document.querySelector("iframe").contentWindow.postMessage({type:"cs2embed:set",spec:{view:"hands"}},"https://cs2inspect.skin")');
    const viewDeadline=Date.now()+5000;
    do{await delay(200);await refreshMessages();report.firstPersonMessages=report.local.messages.slice(messageOffset);if(report.error||report.firstPersonMessages.some(e=>e.type==='view'))break;}while(Date.now()<viewDeadline);
    report.firstPersonAcknowledgement=report.firstPersonMessages.find(e=>e.type==='view')||null;
    report.firstPersonStateVerified=report.firstPersonAcknowledgement?.view==='hands';
    await delay(500);
    const handsShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'cs2inspect-live-'+mode+'-hands.png'),Buffer.from(handsShot.data,'base64'));report.handsScreenshot='cs2inspect-live-'+mode+'-hands.png';
   }
  }
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'cs2inspect-live-'+mode+'.png'),Buffer.from(shot.data,'base64'));await refreshMessages();await cdp.evaluate('GoatSkinViewer.close()');report.framesAfterClose=await cdp.evaluate('document.querySelectorAll("iframe").length');
  fs.writeFileSync(path.join(output,'cs2inspect-live-'+mode+'.json'),JSON.stringify(report,null,2).replaceAll(key,'[configured]'));
  console.log(JSON.stringify({mode,ready:report.ready,providerError:report.error?.reason||null,canvasObserved:report.canvasObserved,framesBeforeClick:report.framesBeforeClick,framesAfterClose:report.framesAfterClose,controls:report.controls,artifacts:'validation/cs2inspect-live-'+mode+'.{json,png}'},null,2));
  assert.equal(report.error,null,'O provedor respondeu com erro: '+(report.error?.reason||''));assert.equal(report.ready,true,'O CS2Inspect não confirmou ready.');assert.equal(report.canvasObserved,true,'Não foi observado um canvas visível.');assert.equal(report.framesBeforeClick,0);assert.equal(report.framesAfterClose,0);assert(report.viewport.documentWidth<=report.viewport.width);assert.deepEqual(report.consoleErrors,[]);
  assert.equal(report.responses.find(response=>response.url.startsWith('https://cs2inspect.skin/embed'))?.status,200,'O documento oficial não respondeu HTTP 200.');
  assert.equal(report.controls?.rotationPixelsChanged,true,'Não foi observada alteração visual após arrastar o modelo.');assert.equal(report.controls?.zoomPixelsChanged,true,'Não foi observada alteração visual após aproximar o modelo.');
  if(kind!=='gloves')assert.equal(report.firstPersonAcknowledgement?.view,'hands','O CS2Inspect não confirmou a câmera em primeira pessoa para este modelo.');
 }finally{
  cdp?.close();if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(path.dirname(path.resolve(profile))!==path.resolve(os.tmpdir())||!path.basename(profile).startsWith('goatskins-cs2inspect-live-'))throw Error('Diretório temporário inesperado.');fs.rmSync(profile,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
