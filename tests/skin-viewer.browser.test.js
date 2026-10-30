/* Chromium real com rede externa bloqueada. Os eventos oficiais são fixtures;
   renderização real requer chave autorizada: scripts/verificar-cs2inspect-live.js. */
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {startBrowser,executable,until}=require('./helpers/browser-cdp');
const key='pk_live_fixture_public',config={item:'ak-47/redline',wear:.18,seed:661,manual:true};
const campaign=(id,viewer_3d)=>({id,premio:'AK-47 | Redline',desgaste:'Field-Tested',descricao:'Skin de demonstração',valor:1000,cor:'#b3263a',fim:'',max:10,max_por_usuario:1,status:'OPEN',preco:0,foto:'',ocupados:[],reservados:[],meus:[],total:0,ganhador:null,commit_hash:'a'.repeat(64),viewer_3d,viewer_3d_reconfigurar:0});
async function fixture(options={}) {
 return startBrowser({directory:path.resolve(__dirname,'../public'),api:async(method,route)=>{
  if(route==='/api/estado')return {data:{eu:null,naoLidas:0,pix:false,viewer3d:{key,configurado:true},s:{titulo:'GOATSKINS',sub:'Sorteios',banner:'',cores:{gold:'#d4aa55',copper:'#b8651f',slate:'#102440',navy:'#0e1a33'}},c:[campaign(1,config),campaign(2,null),campaign(3,{item:'https://evil.test'})]}};
  return {data:{}};
 },...options});
}
async function post(browser,type,extra={},origin='https://cs2inspect.skin',source='document.querySelector(".skin-viewer-frame").contentWindow') {
 return browser.cdp.evaluate('window.dispatchEvent(new MessageEvent("message",{origin:'+JSON.stringify(origin)+',source:'+source+',data:'+JSON.stringify({source:'cs2inspect-embed',type,...extra})+'}))');
}
async function screenshot(browser,name) {
 const result=await browser.cdp.send('Page.captureScreenshot',{format:'png'}),out=path.resolve(__dirname,'../validation');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(result.data,'base64'));
}
test('CS2Inspect no navegador: lazy, URL oficial, ready, Escape, foco, fechar e descarte de iframe', {skip:!executable,timeout:30000},async()=>{
 const b=await fixture();try{
  await b.navigate();await until(()=>b.cdp.evaluate('document.querySelectorAll("#gridAtivos .card").length===3'));
  assert.equal(await b.cdp.evaluate('document.querySelectorAll("iframe").length'),0);assert.equal(b.externalRequests.length,0);
  assert.equal(await b.cdp.evaluate('document.querySelectorAll("#gridAtivos .skin-3d-button").length'),1);
  await b.cdp.evaluate('window.__opener=document.querySelector("#gridAtivos .skin-3d-button");__opener.focus();__opener.click()');
  await until(()=>b.cdp.evaluate('!!document.querySelector("dialog.skin-viewer[open] iframe")'));
  const url=new URL(await b.cdp.evaluate('document.querySelector(".skin-viewer-frame").src'));
  assert.equal(url.origin,'https://cs2inspect.skin');assert.equal(url.pathname,'/embed');assert.equal(url.searchParams.get('key'),key);assert.equal(url.searchParams.get('bg'),'transparent');assert.equal(url.searchParams.get('logo'),'minimal');
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-loading").hidden'),false,'load não deve fingir que o modelo ficou pronto');
  await post(b,'ready');assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-loading").hidden'),true);
  await screenshot(b,'cs2inspect-viewer-desktop');
  await b.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(()=>b.cdp.evaluate('!document.querySelector("dialog.skin-viewer")'));
  assert.equal(await b.cdp.evaluate('document.querySelectorAll("iframe").length'),0);assert.equal(await b.cdp.evaluate('document.activeElement===__opener'),true);
  await b.cdp.evaluate('__opener.click();document.querySelector(".skin-viewer-close").click()');assert.equal(await b.cdp.evaluate('document.body.style.overflow'),'');
  await b.cdp.evaluate('__opener.click();document.querySelector("dialog.skin-viewer").dispatchEvent(new MouseEvent("click",{clientX:0,clientY:0,bubbles:true}))');assert.equal(await b.cdp.evaluate('document.querySelectorAll("iframe").length'),0);
  await b.cdp.evaluate('abrirSorteio(1)');assert.equal(await b.cdp.evaluate('document.querySelectorAll("#saleDetail .skin-3d-button").length'),1);assert.deepEqual(b.pageErrors,[]);
 }finally{await b.close();}
});
test('CS2Inspect: ready/error exigem origem, janela e envelope corretos; erros de chave, item e serviço têm feedback', {skip:!executable,timeout:30000},async()=>{
 const b=await fixture();try{
  await b.navigate();await b.cdp.evaluate('GoatSkinViewer.open({config:'+JSON.stringify(config)+'});true');
  await post(b,'ready',{},'https://evil.example');await post(b,'ready',{},'https://cs2inspect.skin','window');await post(b,'ready',{source:'wrong'});
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-loading").hidden'),false);
  await post(b,'ready');assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-loading").hidden'),true);
  for(const [reason,pattern]of [['no_key',/ainda não foi ativado/],['bad_key',/chave de embed não foi aceita/],['revoked',/chave de embed foi desativada/],['origin_not_allowed',/domínio não está autorizado/],['no_origin',/não identificou a página/],['unknown_item',/não foi encontrado/],['no_model',/não pôde ser carregado/],['rate_limited',/limitou temporariamente/],['untrusted',/não conseguiu preparar/]]) {
   await post(b,'error',{reason,message:'<img src=x onerror=alert(1)>'});assert.match(await b.cdp.evaluate('document.querySelector(".skin-viewer-status").textContent'),pattern);
   assert.equal(await b.cdp.evaluate('document.querySelectorAll(".skin-viewer-status img").length'),0);
  }
  await b.cdp.evaluate('window.__oldFrame=document.querySelector("iframe").contentWindow;document.querySelector(".skin-viewer-retry").click();true');
  await post(b,'ready',{},'https://cs2inspect.skin','__oldFrame');assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-loading").hidden'),false,'janela antiga não confirma novo iframe');
  await post(b,'ready');assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-loading").hidden'),true);
  await b.cdp.evaluate('GoatSkinViewer.close();GoatSkinViewer.configure({key:""});window.__missingKey="";try{GoatSkinViewer.open({config:'+JSON.stringify(config)+'})}catch(e){__missingKey=e.message}');
  assert.match(await b.cdp.evaluate('__missingKey'),/chave pública/);assert.equal(await b.cdp.evaluate('document.querySelectorAll("iframe").length'),0);assert.deepEqual(b.pageErrors,[]);
 }finally{await b.close();}
});
test('CS2Inspect mobile: arma/faca/luva, primeira pessoa, timeout e formulário preservado', {skip:!executable,timeout:30000},async()=>{
 const b=await fixture({width:390,height:844,initialize:'const originalTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{if(ms===25000)window.__simulateTimeout=fn;return originalTimeout(fn,ms,...args)};'});
 try{
  await b.navigate();await b.cdp.evaluate('openModal(true,h("h3",null,"Formulário preservado"),campo("Rascunho","text","Minha skin").w)');
  for(const item of ['ak-47/redline','karambit/doppler','sport-gloves/vice']) {
   await b.cdp.evaluate('GoatSkinViewer.open({config:{item:'+JSON.stringify(item)+',view:"hands"},title:"Minha skin"});true');
   const src=new URL(await b.cdp.evaluate('document.querySelector("iframe").src'));assert.equal(src.searchParams.get('item'),item);assert.equal(src.searchParams.get('view'),'hands');
   await post(b,'ready');await b.cdp.evaluate('GoatSkinViewer.close()');
  }
  await b.cdp.evaluate('GoatSkinViewer.open({config:'+JSON.stringify(config)+',title:"Minha skin"});window.__simulateTimeout()');
  assert.match(await b.cdp.evaluate('document.querySelector(".skin-viewer-status").textContent'),/demorando/);
  await post(b,'ready');assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-status").classList.contains("is-error")'),false);
  const dims=await b.cdp.evaluate('(()=>{const r=document.querySelector("dialog.skin-viewer").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth}})()');
  assert(dims.left>=0&&dims.right<=dims.width&&dims.top>=0&&dims.bottom<=dims.height);assert(dims.scroll<=dims.width);await screenshot(b,'cs2inspect-viewer-mobile');
  await b.cdp.evaluate('GoatSkinViewer.close()');assert.equal(await b.cdp.evaluate('document.querySelector("#modal").hidden'),false);assert.equal(await b.cdp.evaluate('document.querySelector("#modalBody input").value'),'Minha skin');assert.deepEqual(b.pageErrors,[]);
 }finally{await b.close();}
});

test('Controles em português usam mensagens oficiais e preservam câmera, inspeção e interface móvel', {skip:!executable,timeout:30000},async()=>{
 const b=await fixture({width:390,height:844});
 try{
  await b.navigate();await b.cdp.evaluate('GoatSkinViewer.open({config:'+JSON.stringify(config)+',title:"AK-47 | Linha Vermelha"});true');
  const url=new URL(await b.cdp.evaluate('document.querySelector(".skin-viewer-frame").src'));
  for(const field of ['controls','card','ui'])assert.equal(url.searchParams.get(field),'0');
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-description")'),null);
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-help").textContent'),'Se o modelo não aparecer, recarregue a página.');
  // O iframe da fixture não acessa o provedor. Uma janela local permite observar
  // os comandos enviados pelos botões sem interceptar recursos externos.
  await b.cdp.evaluate('new Promise(resolve=>{const f=document.querySelector("iframe");f.addEventListener("load",resolve,{once:true});f.src="about:blank"})');
  await b.cdp.evaluate('window.__commands=[];document.querySelector("iframe").contentWindow.postMessage=(message,origin)=>{__commands.push({message,origin})};true');
  await post(b,'ready',{item:{weapon:'ak47',wear:.3,seed:13}});
  assert.match(await b.cdp.evaluate('document.querySelector(".skin-viewer-metadata").textContent'),/Desgaste: 0,3000 · Padrão: 13/);
  assert.deepEqual(await b.cdp.evaluate('[...document.querySelectorAll(".skin-viewer-tools button")].map(b=>b.textContent)'),['Rotacionar','Primeira pessoa','Inspecionar','Ocultar controles']);
  await b.cdp.evaluate('document.querySelector(".skin-viewer-hands").click()');
  assert.deepEqual(await b.cdp.evaluate('__commands.at(-1)'),{message:{type:'cs2embed:set',spec:{view:'hands'}},origin:'https://cs2inspect.skin'});
  await post(b,'view',{view:'hands'});
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-hands").getAttribute("aria-pressed")'),'true');
  await b.cdp.evaluate('document.querySelector(".skin-viewer-inspect").click()');
  assert.deepEqual(await b.cdp.evaluate('__commands.at(-1)'),{message:{type:'cs2embed:inspect'},origin:'https://cs2inspect.skin'});
  await b.cdp.evaluate('document.querySelector(".skin-viewer-rotate").click()');
  assert.equal(await b.cdp.evaluate('__commands.at(-1).message.spec.view'),'item');
  await post(b,'view',{view:'item'});
  await b.cdp.evaluate('document.querySelector(".skin-viewer-toggle").click()');
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-cameras").hidden'),true);
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-toggle").textContent'),'Mostrar controles');
  await b.cdp.evaluate('document.querySelector(".skin-viewer-toggle").click()');
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-cameras").hidden'),false);
  await post(b,'ready',{item:{weapon:'sporty_gloves',wear:.15,seed:1}});
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-hands").hidden'),true);
  assert.equal(await b.cdp.evaluate('document.querySelector(".skin-viewer-inspect").hidden'),true);
  assert.equal(await b.cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.deepEqual(b.pageErrors,[]);
 }finally{await b.close();}
});
