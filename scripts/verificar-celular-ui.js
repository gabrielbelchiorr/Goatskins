// Verificação visual local: requer Playwright disponível e Chrome instalado.
// Nenhum provedor externo é consultado; APIs e abertura do grupo são interceptadas.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../public');
const server=http.createServer((req,res)=>{
 const file=path.join(root,new URL(req.url,'http://localhost').pathname==='/'?'index.html':new URL(req.url,'http://localhost').pathname.slice(1));
 if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
 fs.readFile(file,(e,b)=>{res.writeHead(e?404:200,{'Content-Type':({'.html':'text/html','.js':'application/javascript','.css':'text/css','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream'});res.end(e?'':b);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const base='http://127.0.0.1:'+server.address().port;
  for(const width of [1440,390,320]){
   const ctx=await browser.newContext({viewport:{width,height:900}}),page=await ctx.newPage(),errors=[];
   let pending=false, filled=false;const calls=[];
   page.on('pageerror',e=>errors.push(e.message));
   await ctx.route('https://chat.whatsapp.com/**',r=>r.fulfill({body:'Grupo interceptado no teste: sem acesso externo'}));
   await ctx.route('**/api/**',async r=>{
    const url=new URL(r.request().url()).pathname;let data={ok:true};calls.push(url);
    if(url==='/api/estado')data={eu:pending?{id:1,nome:'Teste',role:'USER',email_verificado:1,celular_verificado:0,celular_preenchido:filled}:null,naoLidas:0,pix:false,s:{titulo:'GOATSKINS SORTEIOS',sub:'Escolha seus números',cores:{gold:'#e4b45b',copper:'#ae702e',slate:'#102440',navy:'#0c192e'}},c:[]};
    if(url==='/api/celular'){
      if(r.request().method()==='POST'){assert.equal(r.request().postDataJSON().telefone,'(11) 99999-9999');filled=true;}
      data={ok:true,preenchido:filled,celular:filled?'+5511999999999':null};
    }
    await r.fulfill({json:data});
   });
   await page.goto(base);await page.waitForFunction(()=>!document.documentElement.classList.contains('page-loading'));
   await page.evaluate(()=>{document.querySelector('main').style.minHeight='2200px';document.body.classList.add('menu-closed');});
   const link=page.locator('.whatsapp-group');assert.equal(await link.count(),1);await link.waitFor({state:'visible'});
   assert.equal(await link.getAttribute('target'),'_blank');assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
   const rect=await link.boundingBox();assert(rect.x>=0&&rect.x+rect.width<=width);
   if(width<=820){const identity=await page.locator('.hero-identity').boundingBox();assert(identity.x+identity.width<=rect.x);assert((await page.locator('.hero').boundingBox()).height<=110);}
   await page.evaluate(()=>window.scrollTo(0,700));await page.waitForTimeout(350);
   assert(Math.abs((await page.locator('.hero').boundingBox()).y)<2);
   const popupPromise=page.waitForEvent('popup');await link.click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(popup.url(),'https://chat.whatsapp.com/BBlILmZHHfTKPKTxkFyfEj');await popup.close();
   await page.screenshot({path:path.join(__dirname,`../validation/celular-header-${width}.png`)});
   await page.locator('#menuBtn').click();await page.locator('#loginBtn').click();
   await page.getByRole('button',{name:'Criar conta',exact:true}).click();
   const tel=page.getByLabel('Celular com DDD');await tel.fill('11999999999');await tel.dispatchEvent('input');assert.equal(await tel.inputValue(),'(11) 99999-9999');
   pending=true;await page.reload();await page.getByRole('heading',{name:'Concluir cadastro'}).waitFor();
   assert.equal(await page.getByText(/Código SMS|Reenviar em|Confirmar celular/).count(),0);
   const phone=page.getByLabel('Celular com DDD');await phone.fill('11999999999');await phone.dispatchEvent('input');
   await page.getByRole('button',{name:'Salvar celular'}).click();await page.locator('#modal').waitFor({state:'hidden'});
   assert(filled);assert(!calls.some(p=>/celular\/(enviar|confirmar|corrigir)/.test(p)));
   assert.deepEqual(errors,[]);await ctx.close();console.log(`UI ${width}px: sticky, grupo, máscara e celular sem SMS OK`);
  }
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
