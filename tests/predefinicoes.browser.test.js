/* Exercita o formulário e a biblioteca em Chromium real. A API desta suíte é uma
   fixture HTTP local; autenticação, persistência e isolamento têm testes de API próprios. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {startBrowser, executable, until} = require('./helpers/browser-cdp');
const {normalize} = require('../public/cs2inspect');
const root = path.resolve(__dirname, '..');
const photo = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(root,'public/logo.jpg')).toString('base64');
const viewer = normalize({item:'ak-47/redline',wear:.18,seed:661,stattrak:true,stickers:[{slot:0,index:5032,x:.02,y:-.01,rotation:12,wear:.1}],charm:{index:4123,seed:661},view:'hands',manual:true});
const copy = value => JSON.parse(JSON.stringify(value));
const config = {premio:'AK-47 | Redline', desgaste:'Field-Tested', descricao:'Skin da biblioteca', valor:250, preco_numero:2, max:10, max_por_usuario:2, cor:'#b3263a', foto:photo, viewer_3d:viewer,reconfigurar_3d:false};

test('Biblioteca no navegador: CRUD, aplicação sem publicar, foto preservada, ações independentes e mobile', {skip:!executable, timeout:90000}, async () => {
  const presets = new Map([[1,{id:1,nome:'AK Redline — Modelo padrão',dados:copy(config),versao:1,criado_em:'2026-10-30T12:00:00.000Z',atualizado_em:'2026-10-30T12:00:00.000Z'}]]);
  const campaigns = new Map(), writes = []; let nextPreset = 2, nextCampaign = 1, failList = false, emptyList = false;
  const app = await startBrowser({directory:path.join(root,'public'), initialize:`
    window.confirm = () => true;
    window.__requests = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, options) => { window.__requests.push({url:String(url),method:options?.method || 'GET'}); return originalFetch(url,options); };
  `, api:async (method,url,body) => {
    if (url === '/api/estado') return {data:{eu:{id:1,nome:'Administrador local',role:'SUPER_ADMIN',email_verificado:1,celular_preenchido:true},naoLidas:0,pix:false,viewer3d:{key:'pk_test_browser_fixture'},s:{titulo:'GOATSKINS',sub:'Teste local',banner:'',cores:{gold:'#e4b45b',copper:'#ae702e',slate:'#102440',navy:'#0c192e'}},c:[...campaigns.values()].map(c => ({...copy(c),preco:c.preco_numero,foto:c.foto?'/logo.jpg':'',total:0,meus:[],ocupados:[],reservados:[],ganhador:null}))}};
    if (url === '/api/mfa/status') return {data:{enabled:true,verified:true}};
    if (url === '/api/pedidos/pendente') return {data:null};
    if (url === '/api/admin/campanhas/arquivadas') return {data:[]};
    if (method === 'GET' && url === '/api/admin/predefinicoes') return failList ? {status:503,data:{erro:'Biblioteca temporariamente indisponível.'}} : {data:emptyList ? [] : [...presets.values()].map(p => { const result = copy(p); delete result.dados.foto; result.foto = '/logo.jpg'; return result; })};
    if (method === 'POST' && url === '/api/admin/predefinicoes') {
      writes.push({method,url,body:copy(body)});
      const p = {id:nextPreset++,nome:body.nome,dados:copy(body.dados),versao:1,criado_em:new Date().toISOString(),atualizado_em:new Date().toISOString()}; presets.set(p.id,p); return {data:copy(p)};
    }
    let match = /^\/api\/admin\/predefinicoes\/(\d+)(\/duplicar)?$/.exec(url);
    if (match) {
      const p = presets.get(Number(match[1])); if (!p) return {status:404,data:{erro:'Predefinição não encontrada.'}};
      if (method === 'GET') return {data:copy(p)};
      writes.push({method,url,body:copy(body)});
      if (match[2]) { const cloned = {...copy(p),id:nextPreset++,nome:p.nome+' (cópia)',versao:1}; presets.set(cloned.id,cloned); return {data:copy(cloned)}; }
      if (body.versao !== p.versao) return {status:409,data:{erro:'A predefinição foi alterada. Recarregue antes de salvar.'}};
      if (method === 'PUT') { Object.assign(p,{nome:body.nome,dados:copy(body.dados),versao:p.versao+1,atualizado_em:new Date().toISOString()}); return {data:copy(p)}; }
      if (method === 'DELETE') { presets.delete(p.id); return {data:{ok:true}}; }
    }
    if (method === 'POST' && url === '/api/admin/campanhas') { writes.push({method,url,body:copy(body)}); const id = nextCampaign++; campaigns.set(id,{...copy(body),id,status:'OPEN'}); return {data:{ok:true}}; }
    match = /^\/api\/admin\/campanhas\/(\d+)$/.exec(url);
    if (method === 'GET' && match && campaigns.has(Number(match[1]))) return {data:copy(campaigns.get(Number(match[1])))};
    return {status:404,data:{erro:'Fixture route missing: '+method+' '+url}};
  }});
  const {cdp} = app;
  const click = text => cdp.evaluate(`(() => { const b = [...document.querySelectorAll('#modalBody button')].find(b => b.textContent === ${JSON.stringify(text)} && !b.hidden); if (!b) throw Error('Button missing: '+${JSON.stringify(text)}); b.click(); })()`);
  const fill = (label,value) => cdp.evaluate(`(() => { const label = [...document.querySelectorAll('#modalBody label')].find(l=>l.textContent===${JSON.stringify(label)}); if (!label) throw Error('Label missing'); const input = document.getElementById(label.htmlFor); input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const field = label => cdp.evaluate(`document.getElementById([...document.querySelectorAll('#modalBody label')].find(l=>l.textContent===${JSON.stringify(label)}).htmlFor).value`);
  const ready = () => until(() => cdp.evaluate('Boolean(document.querySelector(".raffle-editor")) && !document.querySelector(".raffle-config[aria-busy]")'));
  const library = async () => { await cdp.evaluate('painel("predefinicoes")'); await until(() => cdp.evaluate('Boolean(document.querySelector(".preset-card"))')); };
  try {
    await app.navigate(); await until(() => cdp.evaluate('Boolean(window.GoatSkinViewer) && document.querySelector("#adminBtn").hidden===false'));
    await library();
    await fill('Pesquisar por predefinição ou skin','AK Redline');
    await until(() => cdp.evaluate('window.__requests.some(r=>r.url.includes("?q=AK%20Redline"))'));
    await cdp.evaluate('document.querySelector(".preset-details").open=true');
    await until(() => cdp.evaluate('document.querySelector(".preset-details").textContent.includes("Atualizada em")'));
    await cdp.evaluate(`window.__realViewer=window.GoatSkinViewer; window.GoatSkinViewer={open(){throw Error('Navegador incompatível.');}}; document.querySelector('.preset-card .skin-3d-button').click();`);
    assert.equal(await cdp.evaluate('Boolean(document.querySelector(".preset-card .skin-3d-error")) && !document.querySelector("#modal").hidden'),true,'Falha de navegador mantém a biblioteca aberta com feedback');
    await cdp.evaluate('window.GoatSkinViewer=window.__realViewer; delete window.__realViewer');
    await click('Duplicar'); await until(() => cdp.evaluate('document.querySelectorAll(".preset-card").length===2'));
    assert.equal(presets.size,2);
    await cdp.evaluate(`(() => { const card = [...document.querySelectorAll('.preset-card')].find(c=>c.querySelector('h4').textContent.includes('(cópia)')); [...card.querySelectorAll('button')].find(b=>b.textContent==='Excluir').click(); })()`);
    await until(() => cdp.evaluate('document.querySelectorAll(".preset-card").length===1')); assert.equal(presets.size,1);
    await click('Editar'); await ready(); await fill('Descrição','Configuração revisada');
    await click('Salvar alterações na predefinição original');
    await until(() => cdp.evaluate('Boolean(document.querySelector(".preset-card"))')); assert.equal(presets.get(1).dados.descricao,'Configuração revisada'); assert.equal(presets.get(1).versao,2);
    await click('Criar sorteio'); await ready();
    assert.equal(await field('Skin (ex.: AK-47 | Redline)'),config.premio);
    assert.equal(campaigns.size,0,'Selecionar uma predefinição nunca publica');
    await click('Prévia do sorteio'); await until(() => cdp.evaluate('Boolean(document.querySelector(".raffle-preview .preset-preview"))'));
    assert.equal(await cdp.evaluate('document.querySelector("iframe")===null'),true,'A prévia do formulário não carrega o CS2Inspect');
    await fill('Descrição','Só neste sorteio');
    await click('Adicionar sorteio'); await until(() => campaigns.size===1); await ready();
    assert.equal(campaigns.get(1).foto,photo,'Copiar a predefinição conserva a imagem original');
    assert.deepEqual(campaigns.get(1).viewer_3d,viewer,'Float, seed, StatTrak, stickers, charm e primeira pessoa são reutilizados');
    assert.equal(campaigns.get(1).descricao,'Só neste sorteio'); assert.equal(presets.get(1).dados.descricao,'Configuração revisada','Criar não altera o modelo');
    assert.equal(Object.hasOwn(writes.find(w=>w.url==='/api/admin/campanhas').body,'id'),false);
    await click('Utilizar predefinição'); await until(() => cdp.evaluate('Boolean(document.querySelector(".preset-picker .preset-card"))'));
    await click('Selecionar'); await until(() => cdp.evaluate('document.querySelector(".preset-picker").hidden===true'));
    assert.equal(campaigns.size,1); await fill('Nome da predefinição','Minha nova Redline');
    await click('Salvar como nova predefinição'); await until(() => presets.size===2); await ready();
    assert.equal(campaigns.size,1,'Salvar uma nova predefinição não cria campanha');
    const newPreset = [...presets.values()].find(p=>p.nome==='Minha nova Redline'); newPreset.versao++;
    await click('Salvar alterações na predefinição original');
    await until(() => cdp.evaluate('document.querySelector(".raffle-editor .err").textContent.includes("Recarregue")'));
    await ready(); assert.equal(newPreset.versao,2,'Conflito não substitui a edição de outro administrador');
    await fill('Identificador oficial (ex.: ak-47/redline)','https://evil.test/ak-47/redline');
    await click('Prévia 3D'); await until(() => cdp.evaluate('document.querySelector(".skin-config [role=status]").textContent.includes("sem domínio")'));
    await click('Adicionar sorteio'); await ready();
    assert.equal(campaigns.size,1,'Identificador inválido bloqueia o envio da campanha');
    await click('Remover visualização 3D'); await click('Adicionar sorteio'); await until(() => campaigns.size===2); await ready();
    assert.equal(campaigns.get(2).viewer_3d,null);
    assert.equal(campaigns.get(2).reconfigurar_3d,false);
    await cdp.evaluate('painel("sorteios",S.c.find(c=>c.id===1))'); await ready();
    await fill('Nome da predefinição','Salva a partir da edição'); await click('Salvar como predefinição'); await until(() => presets.size===3);
    assert.equal([...presets.values()].find(p=>p.nome==='Salva a partir da edição').dados.foto,photo);
    await library();
    await click('Criar predefinição'); await ready();
    await fill('Skin (ex.: AK-47 | Redline)','AWP | Asiimov'); await fill('Nome da predefinição','AWP padrão');
    await click('Salvar predefinição'); await until(() => presets.size===4);
    await until(() => cdp.evaluate('document.querySelectorAll(".preset-card").length===4'));
    assert.equal(campaigns.size,2,'Criar na biblioteca não publica sorteio');
    failList = true; await cdp.evaluate('painel("predefinicoes")');
    await until(() => cdp.evaluate('document.querySelector("#modalBody").textContent.includes("Biblioteca temporariamente indisponível")'));
    failList = false; await click('Tentar novamente'); await until(() => cdp.evaluate('document.querySelectorAll(".preset-card").length===4'));
    emptyList = true; await cdp.evaluate('painel("predefinicoes")');
    await until(() => cdp.evaluate('document.querySelector("#modalBody").textContent.includes("Sua biblioteca está vazia")'));
    emptyList = false; await library();
    const output = path.join(root,'validation','skins-presets'); fs.mkdirSync(output,{recursive:true});
    const desktop = await cdp.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(output,'predefinicoes-desktop.png'),Buffer.from(desktop.data,'base64'));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'A biblioteca cabe no viewport mobile');
    const mobile = await cdp.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(output,'predefinicoes-mobile.png'),Buffer.from(mobile.data,'base64'));
    assert.deepEqual(app.pageErrors,[]); assert.deepEqual(app.externalRequests,[]);
  } finally { await app.close(); }
});

test('Configuração 3D no painel: legado preservado, nome/identificadores, faca, luvas e prévia sem publicar', {skip:!executable,timeout:45000}, async () => {
  const legacy={id:11,nome:'Modelo anterior',dados:{...copy(config),viewer_3d:null,reconfigurar_3d:true},reconfigurar_3d:true,versao:1,atualizado_em:'2026-10-30T12:00:00.000Z'};
  const writes=[];
  const app=await startBrowser({directory:path.join(root,'public'),initialize:'window.confirm=()=>true;',api:async(method,url,body)=>{
    if(url==='/api/estado')return {data:{eu:{id:1,nome:'Admin',role:'SUPER_ADMIN',celular_preenchido:true},naoLidas:0,pix:false,viewer3d:{key:'pk_test_browser_fixture'},s:{titulo:'GOATSKINS',sub:'Teste',banner:'',cores:{gold:'#d4aa55',copper:'#b8651f',slate:'#102440',navy:'#0e1a33'}},c:[]}};
    if(url==='/api/mfa/status')return {data:{enabled:true,verified:true}};
    if(url==='/api/pedidos/pendente')return {data:null};
    if(url==='/api/admin/campanhas/arquivadas')return {data:[]};
    if(url==='/api/admin/predefinicoes')return {data:[copy(legacy)]};
    if(url==='/api/admin/predefinicoes/11')return {data:copy(legacy)};
    if(method==='POST'&&url==='/api/admin/campanhas'){writes.push(copy(body));return {data:{ok:true}};}
    return {status:404,data:{erro:'Fixture route missing: '+method+' '+url}};
  }});
  const {cdp}=app;
  const control=label=>'document.getElementById([...document.querySelectorAll("#modalBody label")].find(l=>l.textContent==='+JSON.stringify(label)+').htmlFor)';
  const set=async(label,value)=>cdp.evaluate('(()=>{const i='+control(label)+';'+(typeof value==='boolean'?'i.checked='+value:'i.value='+JSON.stringify(String(value)))+';i.dispatchEvent(new Event("input",{bubbles:true}));i.dispatchEvent(new Event("change",{bubbles:true}));})()');
  const click=text=>cdp.evaluate('(()=>{const b=[...document.querySelectorAll("#modalBody button")].find(b=>b.textContent==='+JSON.stringify(text)+');if(!b)throw Error("Missing button");b.click();})()');
  const ready=()=>until(()=>cdp.evaluate('!!document.querySelector(".raffle-editor")&&!document.querySelector(".raffle-config[aria-busy]")'));
  try {
    await app.navigate();await cdp.evaluate('painel("predefinicoes")');
    await until(()=>cdp.evaluate('!!document.querySelector(".preset-card")'));
    assert.match(await cdp.evaluate('document.querySelector(".preset-card").textContent'),/precisa ser configurada novamente/);
    await click('Criar sorteio');await ready();
    assert.equal(await cdp.evaluate(control('Ativar visualização 3D')+'.checked'),false);
    assert.equal(await cdp.evaluate(control('Descrição')+'.value'),config.descricao);
    await click('Adicionar sorteio');await until(()=>writes.length===1);await ready();
    assert.equal(writes[0].viewer_3d,null);assert.equal(writes[0].reconfigurar_3d,true);assert.equal(writes[0].foto,photo);assert.equal(writes[0].descricao,config.descricao);
    assert.equal(writes[0].premio,config.premio,'A migração não adivinha um item a partir do nome do prêmio');
    await cdp.evaluate('painel("sorteios",{predefinicao:'+JSON.stringify(legacy)+'})');await ready();
    await set('Ativar visualização 3D',true);await set('Nome Steam da skin','AK-47 | Redline (Field-Tested)');await set('Float (wear)',.25);await set('Pattern seed',77);await set('StatTrak',true);
    await click('Adicionar sticker');await set('Índice do sticker',5032);await set('Índice do charm (opcional)',4123);await set('Pattern seed do charm (opcional)',661);
    await cdp.evaluate('window.__originalViewer=GoatSkinViewer;window.GoatSkinViewer={...GoatSkinViewer,open:options=>{window.__previewConfig=options.config}}');
    await click('Prévia 3D');
    const nameConfig=await cdp.evaluate('__previewConfig');assert.equal(nameConfig.name,'AK-47 | Redline (Field-Tested)');assert.equal(nameConfig.wear,.25);assert.equal(nameConfig.seed,77);assert.equal(nameConfig.stattrak,true);assert.equal(nameConfig.stickers[0].index,5032);assert.equal(nameConfig.charm.index,4123);assert.equal(writes.length,1,'Prévia não publica');
    await set('Identificação no CS2Inspect','item');await set('Identificador oficial (ex.: ak-47/redline)','karambit/doppler');
    assert.equal(await cdp.evaluate('document.querySelector(".skin-stickers").disabled'),true);assert.equal(await cdp.evaluate(control('StatTrak')+'.disabled'),false);
    await click('Prévia 3D');assert.equal(await cdp.evaluate('__previewConfig.item'),'karambit/doppler');assert.deepEqual(await cdp.evaluate('__previewConfig.stickers'),[]);assert.equal(await cdp.evaluate('__previewConfig.charm'),null);
    await set('Identificador oficial (ex.: ak-47/redline)','sport-gloves/vice');
    assert.equal(await cdp.evaluate(control('StatTrak')+'.disabled'),true);await click('Prévia 3D');assert.equal(await cdp.evaluate('__previewConfig.stattrak'),false);
    assert.equal(await cdp.evaluate('__previewConfig.item'),'sport-gloves/vice');
    await set('Identificação no CS2Inspect','weapon');await set('Identificador do modelo (ex.: ak47)','ak47');await set('Paint index (opcional)',282);await click('Prévia 3D');
    assert.equal(await cdp.evaluate('__previewConfig.weapon'),'ak47');assert.equal(await cdp.evaluate('__previewConfig.paint'),282);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Os campos estruturados cabem no mobile');
    await cdp.evaluate('document.querySelector(".skin-config").scrollIntoView()');
    const output=path.join(root,'validation','skins-presets');fs.mkdirSync(output,{recursive:true});
    const capture=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'cs2inspect-config-mobile.png'),Buffer.from(capture.data,'base64'));
    await click('Adicionar sorteio');await until(()=>writes.length===2);await ready();assert.equal(writes[1].reconfigurar_3d,false);assert.equal(writes[1].viewer_3d.weapon,'ak47');
    assert.equal(writes[1].premio,config.premio,'Configurar o modelo não modifica os dados reais do prêmio');
    await cdp.evaluate('window.GoatSkinViewer=__originalViewer');
    assert.deepEqual(app.pageErrors,[]);assert.deepEqual(app.externalRequests,[]);
  } finally {await app.close();}
});
