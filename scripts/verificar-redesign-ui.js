/* QA visual local: fixtures explícitas, Chromium real e nenhuma chamada a banco/provedor.
   Uso: node scripts/verificar-redesign-ui.js --before | --after
   Imagens oficiais de fixture são locais e restritas ao QA; não criam campanhas comerciais. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {startBrowser, executable, until} = require('../tests/helpers/browser-cdp');
const {freePort} = require('../tests/helpers/free-port');
const root = path.resolve(__dirname, '..'), output = path.resolve(root, (process.argv.find(a => a.startsWith('--output=')) || '--output=validation/visual-refinement').slice(9));
const fixtures = path.join(root, 'tests/fixtures/skins');
const before = process.argv.includes('--before'), stage = before ? 'before' : 'after';
const widths = [360,390,430,768,1024,1440,1920], checks = [], layouts = [], failures = [];
const initialize = `localStorage.setItem('goatskins-cookies',JSON.stringify({version:1,preferences:false}));`;
const names = ['USP-S | Printstream','AWP | Asiimov','AK-47 | Bloodsport','AWP | Asiimov · QA #2','USP-S | Printstream · QA #2','AK-47 | Bloodsport · QA #2'];
const colors = ['#8edb86','#74b9ff','#bd8aff','#edc36c','#f38288','#dfaf61'];
const imageNames=['usp-printstream.png','awp-asiimov.png','ak47-bloodsport.png','awp-asiimov.png','usp-printstream.png','ak47-bloodsport.png'];
const photo=i=>{const file=path.join(fixtures,imageNames[i]);return fs.existsSync(file)?'data:image/png;base64,'+fs.readFileSync(file).toString('base64'):'';};
const campaigns = names.map((premio,i) => {const total=[3,8,12,20,0,22][i];return {id:i+1,premio,desgaste:'Field-Tested',descricao:'Campanha de teste local — nenhum prêmio ou pagamento real.',valor:[890,670,320,4400,280,5200][i],cor:colors[i],fim:'',max:24,max_por_usuario:3,foto:photo(i),status:'OPEN',preco:[2.89,4.9,1.5,19.9,0,22.5][i],reservados:[total+1],ocupados:Array.from({length:total},(_,n)=>n+1),total,meus:[],ganhador:null,commit_hash:'a'.repeat(64)};});
const closed = {...campaigns[0],id:7,premio:'Campanha encerrada — fixture local',status:'CLOSED'};
const completed = {...campaigns[0],id:8,premio:'Resultado — fixture local',status:'DRAWN',ganhador:{nome:'Participante de teste local',n:1,data:'2026-11-01',total:3,eu:false}};
const crypto = require('node:crypto'), sha = v => crypto.createHash('sha256').update(v).digest('hex');
const proofSeed = crypto.randomBytes(32).toString('hex'), proofNumbers = [1,2,3], proofSnapshot = sha(proofNumbers.join(','));
const proofWinner = proofNumbers[Number(BigInt('0x'+crypto.createHmac('sha256',proofSeed).update(proofSnapshot).digest('hex')) % BigInt(proofNumbers.length))];
completed.ganhador.n = proofWinner; completed.commit_hash = sha(proofSeed);
const proof = {status:'DRAWN',commit_hash:sha(proofSeed),seed:proofSeed,snapshot_hash:proofSnapshot,metodo:'HMAC-SHA256(semente, sha256(numeros)) mod N',sorteado_em:'2026-11-01T12:00:00.000Z',numeros:proofNumbers,vencedor:proofWinner};
let mode = 'normal', user = null;
const order = {id:'a'.repeat(32),campanha:1,premio:names[0],numeros:[5,6],total:5.78,status:'PENDING',expira_em:Date.now()+300000,criado_em:new Date().toISOString(),pix:{qr_code:'FIXTURE LOCAL SEM PAGAMENTO REAL',qr_code_base64:null,ticket_url:null}};
function state() { return {eu:user,naoLidas:0,pix:true,viewer3d:{key:'',configurado:false},s:{titulo:'GOATSKINS SORTEIOS',sub:'Escolha seus números e concorra a skins de CS.',banner:'',cores:{gold:'#f08a2b',copper:'#c4621a',slate:'#0e0d0c',navy:'#181716'}},c:mode==='empty'?[]:[...campaigns,closed,completed]}; }
async function api(method,route,body) {
  if(route==='/api/estado') return mode==='error'?{status:503,data:{erro:'Fixture de indisponibilidade local.'}}:{data:state()};
  if(route==='/api/pedidos/pendente') return {data:null};
  if(route==='/api/campanhas/8/verificacao') return {data:mode==='tampered'?{...proof,seed:crypto.randomBytes(32).toString('hex')}:proof};
  if(route==='/api/campanhas/1/pedidos' && method==='POST') { assert.deepEqual(body.numeros,[5,6]); return {data:order}; }
  if(route.startsWith('/api/pedidos/')) return {data:order};
  if(route==='/api/esqueci-senha') return {data:{ok:true}};
  return {data:[]};
}
async function capture(b,name,full=false) {
  const result = await b.cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:full});
  const filename = path.join(output,stage+'-'+name+'.png');
  fs.writeFileSync(filename,Buffer.from(result.data,'base64')); return path.relative(root,filename);
}
async function viewport(b,width) {
  await b.cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===1920?1080:width<821?900:1000,deviceScaleFactor:1,mobile:false});
  await b.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function measure(b,label) {
  const value = await b.cdp.evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
    overflow:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&(r.right>innerWidth+1||r.left< -1)}).slice(0,12).map(e=>({tag:e.tagName,id:e.id,class:e.className,left:Math.round(e.getBoundingClientRect().left),right:Math.round(e.getBoundingClientRect().right)}))}))()`);
  layouts.push({label,...value}); assert(value.scrollWidth<=value.width+1,label+': horizontal overflow '+JSON.stringify(value));
}
async function check(label,run) {
  try { await run(); checks.push(label); console.log('PASS '+label); }
  catch(error) { failures.push({label,error:error.message}); console.error('FAIL '+label+': '+error.message); }
}
async function snapshotDirectory() {
  if(!before) return {directory:path.join(root,'public'),cleanup:()=>{}};
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'goatskins-redesign-qa-'));
  // Recursos públicos compartilhados continuam locais; o snapshot persistente contém só os arquivos solicitados.
  for(const entry of fs.readdirSync(path.join(root,'public'),{withFileTypes:true})) {
    const source = path.join(root,'public',entry.name), target = path.join(directory,entry.name);
    if(entry.isDirectory()) fs.cpSync(source,target,{recursive:true}); else fs.copyFileSync(source,target);
  }
  for(const file of ['index.html','style.css','script.js','premium.css','journey.css'].filter(f=>fs.existsSync(path.join(output,'before',f)))) fs.copyFileSync(path.join(output,'before',file),path.join(directory,file));
  return {directory,cleanup:()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('goatskins-redesign-qa-'));fs.rmSync(directory,{recursive:true,force:true});}};
}
async function main() {
  if(!executable) throw Error('Chrome/Edge local necessário.');
  fs.mkdirSync(output,{recursive:true});
  const source = await snapshotDirectory(); let b;
  try {
    b = await startBrowser({directory:source.directory,api,initialize}); await b.navigate();
    await until(()=>b.cdp.evaluate('document.querySelectorAll("#gridAtivos .card").length===6'));
    if(before) {
      for(const width of [1440,1920,390]) { await viewport(b,width); await capture(b,'home-'+width); layouts.push({label:'home',width,scrollWidth:await b.cdp.evaluate('document.documentElement.scrollWidth')}); }
      checks.push('Capturas baseline desktop/mobile com fixtures locais'); return;
    }
    for(const width of widths) await check('Home '+width+'px',async()=>{
      await viewport(b,width); await measure(b,'home-'+width);
      const headerHeight=await b.cdp.evaluate('document.querySelector(".site-header").getBoundingClientRect().height');
      assert(headerHeight<=(width>820?112:85),'Header ocupa espaço excessivo: '+headerHeight+'px');
      const layout=await b.cdp.evaluate(`(()=>{const side=document.getElementById('menuLateral'),s=side.getBoundingClientRect(),main=document.querySelector('.shell').getBoundingClientRect(),hero=document.getElementById('inicio').getBoundingClientRect();return {sideFixed:getComputedStyle(side).position,sideRight:s.right,contentLeft:main.left,heroHeight:hero.height,gridTop:document.getElementById('gridAtivos').getBoundingClientRect().top,closed:document.body.classList.contains('menu-closed')}})()`);
      layouts.push({label:'composition-'+width,width,...layout});
      assert(layout.heroHeight<=300,'Banner deve permanecer compacto: '+layout.heroHeight);
      if(width>820){assert.equal(layout.sideFixed,'fixed');assert.equal(layout.closed,false);assert(layout.contentLeft>=layout.sideRight-1,'Sidebar sobrepõe o conteúdo');assert(layout.gridTop<510,'Cards devem aparecer na primeira tela');}
      else assert.equal(layout.closed,true);
      assert.equal(await b.cdp.evaluate('document.querySelectorAll("#gridAtivos .card").length'),6);
      if([390,1440,1920].includes(width)) {
        await capture(b,'home-'+width);
        await b.cdp.evaluate('document.getElementById("gridAtivos").scrollIntoView({block:"start"})');
        await capture(b,'grid-'+width); await b.cdp.evaluate('window.scrollTo(0,0)');
      }
    });
    await check('Imagens carregadas removem skeleton e estado ocupado',async()=>{
      await until(()=>b.cdp.evaluate('[...document.querySelectorAll("#gridAtivos .prize img")].some(img=>img.complete&&img.naturalWidth>0)'));
      assert.equal(await b.cdp.evaluate('[...document.querySelectorAll("#gridAtivos .prize img")].filter(img=>img.complete&&img.naturalWidth>0).every(img=>!img.parentElement.classList.contains("skeleton")&&!img.parentElement.hasAttribute("aria-busy"))'),true);
    });
    await check('Erro de imagem remove skeleton e preserva abertura do sorteio',async()=>{
      await b.cdp.evaluate('window.__qaBrokenPrize=document.querySelector("#gridAtivos .prize");__qaBrokenPrize.querySelector("img").dispatchEvent(new Event("error"))');
      const fallback=await b.cdp.evaluate('({text:__qaBrokenPrize.textContent,busy:__qaBrokenPrize.hasAttribute("aria-busy"),skeleton:__qaBrokenPrize.classList.contains("skeleton"),disabled:__qaBrokenPrize.disabled,image:!!__qaBrokenPrize.querySelector("img")})');
      assert.match(fallback.text,/Imagem indisponível/); assert.equal(fallback.busy,false); assert.equal(fallback.skeleton,false); assert.equal(fallback.disabled,false); assert.equal(fallback.image,false);
      await b.cdp.evaluate('__qaBrokenPrize.click()');
      assert.match(await b.cdp.evaluate('document.querySelector("#saleDetail h1").textContent'),/Bloodsport.*QA #2/);
      await b.cdp.evaluate('navegar("sorteios")');
    });
    await check('Skeleton respeita preferência de movimento reduzido',async()=>{
      assert.equal(await b.cdp.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'),true);
      const animation=await b.cdp.evaluate('(()=>{const probe=document.createElement("div");probe.className="skeleton";document.body.append(probe);const animation=getComputedStyle(probe,"::after").animationName;probe.remove();return animation})()');
      assert.equal(animation,'none');
    });
    await check('Pesquisa removida da home sem deixar espaço vazio',async()=>{
      assert.equal(await b.cdp.evaluate('document.querySelector(".view[data-view=sorteios] input[type=search],#campaignSearch,#noCampaignMatches,#clearCampaignSearch")===null'),true);
      assert.equal(await b.cdp.evaluate('document.querySelector(".campaign-toolbar")===null'),true);
      assert.equal(await b.cdp.evaluate('document.getElementById("ativos").nextElementSibling.id'), 'campaignResults');
      assert.equal(await b.cdp.evaluate('document.getElementById("activeCount").textContent'),'6');
    });
    await check('Ordenação por preço, prêmio e progresso usa os dados',async()=>{
      for(const [value,expected] of [['price-asc','USP-S'],['prize-desc','AK-47']]) {
        await b.cdp.evaluate('campaignSort.value='+JSON.stringify(value)+';campaignSort.dispatchEvent(new Event("change",{bubbles:true}))');
        assert.match(await b.cdp.evaluate('document.querySelector("#gridAtivos .card h3").textContent'),new RegExp(expected));
      }
      await b.cdp.evaluate('campaignSort.value="progress-desc";campaignSort.dispatchEvent(new Event("change",{bubbles:true}))');
      assert.equal(await b.cdp.evaluate('document.querySelectorAll("#gridAtivos .card").length'),6);
      assert.match(await b.cdp.evaluate('document.querySelector("#gridAtivos .card h3").textContent'),/Bloodsport.*QA #2/);
      await b.cdp.evaluate('campaignSort.value="recent";campaignSort.dispatchEvent(new Event("change",{bubbles:true}))');
    });
    await check('Valores monetários usam a mesma cor em todos os cards',async()=>{
      const result=await b.cdp.evaluate(`(()=>{const nodes=[...document.querySelectorAll('#gridAtivos .card-value strong,#gridAtivos .price strong,#heroFeatured .money')];const probe=document.createElement('span');probe.className='money';document.body.append(probe);const expected=getComputedStyle(probe).color;probe.remove();return {count:nodes.length,expected,colors:nodes.map(n=>getComputedStyle(n).color)}})()`);
      assert(result.count>=12); assert(result.colors.every(color=>color===result.expected));
      assert.equal(await b.cdp.evaluate('document.querySelectorAll("#gridAtivos .card-admin").length'),0,'Visitantes não veem controles administrativos');
      assert.equal(await b.cdp.evaluate('document.querySelector("#inicio img[src*=mascote]")===null'),true);
    });
    await check('Ordenação mantém nome acessível em mobile',async()=>{
      await viewport(b,390);
      const doc=await b.cdp.send('DOM.getDocument');
      const select=await b.cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#campaignSort'});
      const tree=await b.cdp.send('Accessibility.getPartialAXTree',{nodeId:select.nodeId,fetchRelatives:false});
      const control=tree.nodes.find(node=>node.role?.value==='combobox');
      assert(control?.name?.value?.trim(),'O controle de ordenação precisa ter nome para leitores de tela.');
    });
    await check('Menu móvel abre e fecha por Escape e navegação',async()=>{
      await viewport(b,390); await b.cdp.evaluate('menuAberto(false);document.getElementById("menuBtn").click()');
      assert.equal(await b.cdp.evaluate('document.getElementById("menuBtn").getAttribute("aria-expanded")'),'true');
      await capture(b,'menu-390');
      await b.cdp.evaluate('document.getElementById("menuBtn").focus()');
      await b.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      assert.equal(await b.cdp.evaluate('document.getElementById("menuLateral").contains(document.activeElement)'),true,'Tab entra na sidebar');
      await b.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      assert.equal(await b.cdp.evaluate('document.getElementById("menuBtn").getAttribute("aria-expanded")'),'false');
      await b.cdp.evaluate('menuAberto(true);document.querySelector(".nv[data-view=historico]").click()');
      assert.equal(await b.cdp.evaluate('document.getElementById("menuBtn").getAttribute("aria-expanded")'),'false');
      await b.cdp.evaluate('navegar("sorteios")');
    });
    await check('Sidebar admin mantém ações separadas dos cards públicos',async()=>{
      user={id:1,nome:'Administrador de teste local',role:'SUPER_ADMIN',email_verificado:1,celular_preenchido:true}; await b.cdp.evaluate('carregar()');
      for(const width of [821,900,1024,1440]) {
        await viewport(b,width); await measure(b,'admin-header-'+width);
        assert.equal(await b.cdp.evaluate('document.getElementById("adminBtn").hidden'),false);
        assert.equal(await b.cdp.evaluate('document.getElementById("contaBtn").hidden'),false);
        assert.equal(await b.cdp.evaluate('document.querySelectorAll("#gridAtivos .card-admin").length'),6);
        assert.equal(await b.cdp.evaluate('[...document.querySelectorAll("#gridAtivos .card-admin")].every(e=>!e.open)'),true);
        const height=await b.cdp.evaluate('document.querySelector(".site-header").getBoundingClientRect().height');
        assert(height<=(width<=1050?160:112),'Header admin ocupa espaço excessivo: '+height+'px');
      }
      await b.cdp.evaluate('document.querySelector("#gridAtivos .card-admin").open=true');
      assert.equal(await b.cdp.evaluate('document.querySelector("#gridAtivos .sale-edit-btn").getClientRects().length>0'),true);
      await capture(b,'admin-card-1440');
      await b.cdp.evaluate('document.querySelector("#gridAtivos .card-admin").open=false');
    });
    await check('Sidebar desktop recolhe e expande liberando a largura do conteúdo',async()=>{
      await viewport(b,1440);await b.cdp.evaluate('menuAberto(false,true)');
      assert.equal(await b.cdp.evaluate('document.getElementById("menuLateral").inert'),true);
      assert.equal(await b.cdp.evaluate('document.querySelector(".shell").getBoundingClientRect().left'),0);
      await b.cdp.evaluate('menuAberto(true,true)');
      assert.equal(await b.cdp.evaluate('document.getElementById("menuLateral").inert'),false);
      assert(await b.cdp.evaluate('document.querySelector(".shell").getBoundingClientRect().left>=230'));
    });
    await check('Header de conta com nome longo permanece dentro da tela',async()=>{
      user={id:1,nome:'A'.repeat(80),role:'USER',email_verificado:1,celular_preenchido:true}; await b.cdp.evaluate('carregar()');
      for(const width of [821,1440]) {
        await viewport(b,width); await measure(b,'long-name-header-'+width);
        const box=await b.cdp.evaluate('(()=>{const r=document.getElementById("loginBtn").getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()');
        assert(box.left>=0&&box.right<=box.width,'Logout com nome longo transborda a tela.');
      }
    });
    await check('Detalhe respeita reservas, limite e resumo de seleção',async()=>{
      user={id:1,nome:'Conta de teste local',role:'USER',email_verificado:1,celular_preenchido:true}; await b.cdp.evaluate('carregar()');
      await b.cdp.evaluate('abrirSorteio(1)');
      assert.equal(await b.cdp.evaluate('document.querySelectorAll(".sale-grid .num").length'),24);
      assert.equal(await b.cdp.evaluate('document.querySelectorAll(".sale-grid .num:disabled").length'),4);
      await b.cdp.evaluate('document.querySelectorAll(".sale-grid .num")[4].click();document.querySelectorAll(".sale-grid .num")[5].click()');
      assert.match(await b.cdp.evaluate('document.querySelector(".sale-checkout-total").textContent'),/2 números selecionados: 05, 06.*5,78/);
      await b.cdp.evaluate('document.querySelectorAll(".sale-grid .num")[6].click();document.querySelectorAll(".sale-grid .num")[7].click()');
      assert.equal(await b.cdp.evaluate('document.querySelectorAll(".sale-grid .num[aria-pressed=true]").length'),3);
      await b.cdp.evaluate('document.querySelectorAll(".sale-grid .num")[6].click()');
      for(const width of widths) {
        await viewport(b,width); await measure(b,'detail-'+width);
        // O resumo vem depois da grade no fluxo e, com seleção, acompanha a rolagem (sticky) sem sair da seção.
        assert.equal(await b.cdp.evaluate('!!(document.querySelector(".sale-grid").compareDocumentPosition(document.querySelector(".sale-checkout"))&Node.DOCUMENT_POSITION_FOLLOWING)&&document.querySelector(".sale-checkout").classList.contains("has-selection")&&getComputedStyle(document.querySelector(".sale-checkout")).position==="sticky"'),true,'Resumo com seleção deve vir após a grade e acompanhar a rolagem.');
        assert.equal(await b.cdp.evaluate('(()=>{const c=document.querySelector(".sale-checkout");scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"});const ok=c.getBoundingClientRect().top>=document.querySelector(".sale-grid").getBoundingClientRect().bottom-1;scrollTo({top:0,behavior:"instant"});return ok;})()'),true,'Depois de rolar a grade, o resumo fica após os números.');
        if([390,1440].includes(width)) {
          await capture(b,'detail-'+width);
          await b.cdp.evaluate('document.querySelector(".sale-numbers").scrollIntoView({block:"start"})');
          await capture(b,'numbers-'+width); await b.cdp.evaluate('window.scrollTo(0,0)');
        }
      }
    });
    await check('Reserva envia somente números selecionados e abre Pix local',async()=>{
      await viewport(b,390); await b.cdp.evaluate('document.querySelector(".sale-pay-btn").click()');
      await until(()=>b.cdp.evaluate('!!document.querySelector(".pix-panel")'));
      assert.match(await b.cdp.evaluate('document.querySelector(".pix-detail").textContent'),/5,78/);
      assert.equal(await b.cdp.evaluate('document.querySelector(".pixcode").value'),order.pix.qr_code);
      await measure(b,'pix-390'); await capture(b,'pix-390');
      await b.cdp.evaluate('closeModal()');
    });
    for(const width of widths) for(const authMode of ['entrar','criar','esqueci']) await check('Conta '+authMode+' '+width+'px',async()=>{
      await viewport(b,width); await b.cdp.evaluate('authModal('+JSON.stringify(authMode)+')');
      await measure(b,'auth-'+authMode+'-'+width);
      assert.equal(await b.cdp.evaluate('document.querySelectorAll("#modalBody input[type=email]").length'),1);
      assert.equal(await b.cdp.evaluate('[...document.querySelectorAll("#modalBody input:not([type=checkbox])")].every(i=>!!i.id&&!!document.querySelector("label[for=\\""+i.id+"\\"]"))'),true);
      if([390,1440].includes(width)) await capture(b,'auth-'+authMode+'-'+width);
      await b.cdp.evaluate('closeModal()');
    });
    await check('Modal mantém fundo inerte ao redimensionar entre mobile e desktop',async()=>{
      await viewport(b,390); await b.cdp.evaluate('menuAberto(true);authModal("entrar")');
      for(const width of [1440,390]) { await viewport(b,width); assert.equal(await b.cdp.evaluate('document.querySelector(".site-header").inert'),true); assert.equal(await b.cdp.evaluate('document.getElementById("menuLateral").inert'),true); }
      await viewport(b,1440); await b.cdp.evaluate('closeModal()');
      assert.equal(await b.cdp.evaluate('document.querySelector(".site-header").inert'),false);
      assert.equal(await b.cdp.evaluate('document.querySelector(".shell").inert'),false);
    });
    await check('Campanhas vazias preservam navegação e estado vazio',async()=>{
      mode='empty'; await b.cdp.evaluate('navegar("sorteios");carregar()');
      assert.equal(await b.cdp.evaluate('document.querySelectorAll("#gridAtivos .card").length'),0);
      assert.equal(await b.cdp.evaluate('document.getElementById("noAtivos").hidden'),false);
      await viewport(b,390); await measure(b,'empty-390'); await capture(b,'empty-390');
    });
    await check('Falha de carregamento mostra erro e botão de tentar novamente',async()=>{
      mode='error'; await b.cdp.send('Page.navigate',{url:b.base+'/'});
      await until(()=>b.cdp.evaluate('!!document.querySelector("#pageLoader.is-error")'));
      assert.equal(await b.cdp.evaluate('document.getElementById("loaderRetry").hidden'),false);
      await capture(b,'error-390'); mode='normal';
    });
    for(const route of ['/termos.html','/privacidade.html','/cookies.html']) await check('Leitura da página '+route+' em mobile e desktop',async()=>{
      await b.navigate(route);
      for(const width of [390,768,1440]){await viewport(b,width);await measure(b,'legal-'+route+'-'+width);}
    });
    await check('Detalhe explica as regras e mostra o resultado sem expor a semente',async()=>{
      mode='normal'; user=null; await b.navigate('/'); await until(()=>b.cdp.evaluate('document.querySelectorAll("#gridAtivos .card").length===6'));
      assert.match(await b.cdp.evaluate('document.getElementById("heroStats").textContent'),/1sorteio realizado/);
      await b.cdp.evaluate('abrirSorteio(1)');
      assert.match(await b.cdp.evaluate('document.getElementById("sale-regras").textContent'),/5 minutos.*encerrar as inscrições antes/s);
      for(const width of [390,1440]){await viewport(b,width);await measure(b,'rules-'+width);}
      await b.cdp.evaluate('abrirSorteio(8)');
      assert.match(await b.cdp.evaluate('document.querySelector(".sale-result").textContent'),new RegExp('Número 0'+proofWinner));
      // Decisão do responsável (22/10 e 17/11): a prova não aparece na interface.
      assert.equal(await b.cdp.evaluate('document.querySelector("#sale-prova,.proof-result")===null && !/semente|SHA-256|HMAC/i.test(document.getElementById("saleDetail").textContent)'),true);
      assert.equal(b.requests.some(r=>r.pathname.endsWith('/verificacao')),false,'a interface não consulta a prova');
      await b.cdp.evaluate('navegar("sorteios")');
    });
    await check('Conta conectada: identidade no topo e Sair como ação secundária',async()=>{
      user={id:1,nome:'Conta de teste local',role:'USER',email_verificado:1,celular_preenchido:true}; await b.cdp.evaluate('carregar()'); await viewport(b,1440);
      assert.equal(await b.cdp.evaluate('document.getElementById("contaResumo").hidden'),false);
      assert.equal(await b.cdp.evaluate('document.querySelector("#contaResumo strong").textContent'),'Conta');
      const pos=await b.cdp.evaluate('(()=>{const l=document.getElementById("loginBtn"),n=document.querySelector(".nv[data-view=bilhetes]");return {after:l.getBoundingClientRect().top>n.getBoundingClientRect().top,bg:getComputedStyle(l).backgroundColor}})()');
      assert.equal(pos.after,true,'Sair deve ficar abaixo da navegação'); assert.ok(['rgba(0, 0, 0, 0)','transparent'].includes(pos.bg),'Sair não deve usar o fundo dourado: '+pos.bg);
      await capture(b,'account-sidebar-1440'); user=null; await b.cdp.evaluate('carregar()');
    });
    await check('Nenhuma exceção JavaScript ou requisição externa',async()=>{assert.deepEqual(b.pageErrors,[]);assert.deepEqual(b.externalRequests,[]);});
  } finally {
    if(b) await b.close(); source.cleanup();
    const result={stage,fixtureOnly:true,noDatabase:true,externalNetworkBlocked:true,checks,failures,layouts};
    fs.writeFileSync(path.join(output,stage+'-qa.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({stage,pass:checks.length,fail:failures.length,output:path.relative(root,output)}));
    if(failures.length) process.exitCode=1;
  }
}
async function httpAssets() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'goatskins-redesign-http-'));
  const port=await freePort(),base='http://127.0.0.1:'+port;
  const env={...process.env,...require('../tests/helpers/ambiente-teste'),TESTE:'1',PORT:String(port),APP_URL:base,DATA_DIR:directory};
  delete env.TEST_DATABASE_URL;
  env.NODE_OPTIONS='--require '+JSON.stringify(path.join(root,'scripts/security-isolation.js').replaceAll('\\','/'));
  const child=spawn(process.execPath,['--no-warnings','-r','./tests/helpers/pg-falso.js','server.js'],{cwd:root,env,stdio:'ignore',windowsHide:true});
  const assets=['style.css','logo-nav.webp','logo-loader.webp','mascote-hero.webp','fonts/barlow-regular.woff2','fonts/barlow-semibold.woff2','fonts/barlow-condensed-bold.woff2','fonts/barlow-condensed-extrabold.woff2'];
  const results=[];
  try {
    await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}},'Servidor HTTP de fixture indisponível');
    for(const asset of assets) {
      const response=await fetch(base+'/'+asset),body=Buffer.from(await response.arrayBuffer());
      assert.equal(response.status,200,asset);
      assert.equal(response.headers.get('content-type'),asset.endsWith('.woff2')?'font/woff2':asset.endsWith('.css')?'text/css':'image/webp',asset);
      assert.deepEqual(body,fs.readFileSync(path.join(root,'public',asset)),asset+' bytes');
      results.push({asset,status:response.status,type:response.headers.get('content-type'),bytes:body.length});
    }
    for(const asset of ['.env','fonts/unlisted.woff2','public/style.css','premium.css','journey.css','roulette.css']) {
      const response=await fetch(base+'/'+asset); assert([403,404].includes(response.status),asset+' deve permanecer privado');
      await response.arrayBuffer(); results.push({asset,status:response.status});
    }
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'http-assets.json'),JSON.stringify({realServer:true,fakeDatabase:true,externalNetworkBlocked:true,results},null,2)+'\n');
    console.log('PASS HTTP real: '+assets.length+' assets com MIME/bytes corretos; caminhos não autorizados e CSS antigos bloqueados (403/404).');
  } finally {
    if(child.exitCode===null&&child.signalCode===null) await new Promise(resolve=>{child.once('close',resolve);child.kill();});
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('goatskins-redesign-http-'));
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
(process.argv.includes('--http-only')?httpAssets():main()).catch(error=>{console.error(error.stack);process.exitCode=1;});
