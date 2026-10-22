// Verificação local, com Chrome + Playwright. APIs simuladas, sem contas ou pagamentos reais.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../public');
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 const file=path.join(root,pathname==='/'?'index.html':pathname.slice(1));
 if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
 fs.readFile(file,(e,b)=>{res.writeHead(e?404:200,{'Content-Type':({'.html':'text/html','.js':'application/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream'});res.end(e?'':b);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  for(const width of [1440,390,320]){
   const ctx=await browser.newContext({viewport:{width,height:900}}),page=await ctx.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await ctx.route('**/api/**',r=>r.fulfill({json:{eu:null,naoLidas:0,pix:false,s:{titulo:'GOATSKINS',sub:'Teste',cores:{gold:'#e4b45b'}},c:[]}}));
   await page.goto(base);const banner=page.locator('.cookie-banner');await banner.waitFor({state:'visible'});
   const bounds=await banner.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.y>=0);
   await page.evaluate(()=>{localStorage.setItem('menu','0');sessionStorage.setItem('goatskins-confirmacao','fixture');});
   await page.reload();assert.equal(await page.locator('#menuBtn').getAttribute('aria-expanded'),width>820?'true':'false');
   await ctx.addCookies([{name:'sid',value:'sessao-ficticia',url:base,httpOnly:true,sameSite:'Lax'}]);
   await page.getByRole('button',{name:'Somente essenciais',exact:true}).click();await banner.waitFor({state:'hidden'});
   assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('goatskins-cookies'))),{version:1,preferences:false});
   assert.equal(await page.evaluate(()=>localStorage.getItem('menu')),null);assert.equal(await page.evaluate(()=>sessionStorage.getItem('goatskins-confirmacao')),'fixture');
   assert((await ctx.cookies()).some(c=>c.name==='sid'));
   await page.locator('#menuBtn').click();assert.equal(await page.evaluate(()=>localStorage.getItem('menu')),null);
   await page.reload();await banner.waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Preferências de cookies',exact:true}).click();await banner.waitFor({state:'visible'});
   await page.getByRole('button',{name:'Aceitar cookies',exact:true}).click();
   assert.equal(await page.evaluate(()=>window.GoatskinsCookies.allowsPreferences()),true);
   if(width>820){await page.locator('#menuBtn').click();assert.equal(await page.evaluate(()=>localStorage.getItem('menu')),'0');}
   for(const route of ['/cookies.html','/privacidade.html','/termos.html']){
    await page.goto(base+route);await banner.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Preferências de cookies',exact:true}).click();await banner.waitFor({state:'visible'});
    await page.getByRole('button',{name:'Somente essenciais',exact:true}).click();
   }
   await page.getByRole('button',{name:'Preferências de cookies',exact:true}).click();
   await page.screenshot({path:path.join(__dirname,`../validation/cookies-${width}.png`)});
   assert.deepEqual(errors,[]);await ctx.close();console.log(`Cookies ${width}px: primeiro acesso, escolhas, menu, persistência, políticas e sessão OK`);
  }
  const blocked=await browser.newContext();await blocked.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}}));
  const p=await blocked.newPage();await p.goto(base+'/cookies.html');await p.getByRole('button',{name:'Somente essenciais',exact:true}).click();await p.locator('.cookie-banner').waitFor({state:'hidden'});
  await p.reload();await p.locator('.cookie-banner').waitFor({state:'visible'});await blocked.close();console.log('Armazenamento bloqueado: navegação e escolha temporária OK');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
