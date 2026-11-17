/* Regressão de CSS por estilo computado: abre a MESMA interface (mesmo HTML/JS e fixtures) com uma
   pasta de referência e com public/ atual, em dois Chromes em paralelo, percorre telas e estados em
   várias larguras e compara getComputedStyle de cada elemento do <body> (e de ::before/::after/::placeholder).
   Uso: node scripts/comparar-estilos.js --referencia=<pasta public antiga> [--larguras=390,820,1440]
   Sem banco, sem provedores e com rede externa bloqueada; dados são fixtures locais. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { startBrowser, executable, until } = require('../tests/helpers/browser-cdp');
const root = path.resolve(__dirname, '..');
const arg = (k, d) => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').slice(k.length + 3) || d;
const referencia = path.resolve(arg('referencia', ''));
const larguras = arg('larguras', '390,820,1440').split(',').map(Number);
if (!fs.existsSync(path.join(referencia, 'index.html'))) { console.error('Use --referencia=<pasta com a public antiga>'); process.exit(2); }

/* ---------- fixtures ---------- */
const fixtures = path.join(root, 'tests/fixtures/skins');
const foto = f => 'data:image/png;base64,' + fs.readFileSync(path.join(fixtures, f)).toString('base64');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const seed = 'b'.repeat(64), numerosProva = [1, 2, 3], snapshot = sha(numerosProva.join(','));
const vencedor = numerosProva[Number(BigInt('0x' + crypto.createHmac('sha256', seed).update(snapshot).digest('hex')) % 3n)];
const viewer = { item: 'ak-47/redline', wear: 0.18, seed: 661, stattrak: false, nametag: '', stickers: [], charm: null, view: 'item', manual: true };
const base = { desgaste: 'Field-Tested', descricao: 'Fixture local — sem prêmio ou pagamento real.', cor: '#b3263a', fim: '', max: 24, max_por_usuario: 3,
  status: 'OPEN', reservados: [], ocupados: [], total: 0, meus: [], ganhador: null, commit_hash: sha(seed), viewer_3d: null, reconfigurar_3d: false };
const campanhas = () => [
  { ...base, id: 1, premio: 'AK-47 | Bloodsport', valor: 320, preco: 2.89, foto: foto('ak47-bloodsport.png'), reservados: [4], ocupados: [1, 2, 3], total: 3, meus: estado.usuario ? [3] : [], viewer_3d: viewer },
  { ...base, id: 2, premio: 'USP-S | Printstream', valor: 280, preco: 0, foto: foto('usp-printstream.png') },
  { ...base, id: 3, premio: 'AWP | Asiimov com um nome bem longo para testar quebra de linha', valor: 4400, preco: 19.9, foto: '', ocupados: Array.from({ length: 20 }, (_, i) => i + 1), total: 20 },
  { ...base, id: 7, premio: 'Encerrado', valor: 100, preco: 1.5, foto: foto('awp-asiimov.png'), status: 'CLOSED', ocupados: [1, 2], total: 2 },
  { ...base, id: 8, premio: 'Realizado', valor: 500, preco: 5, foto: foto('ak47-bloodsport.png'), status: 'DRAWN', max: 3, ocupados: [1, 2, 3], total: 3,
    ganhador: { nome: 'Participante T.', n: vencedor, data: '2026-11-01', total: 3, eu: false } }
];
const estado = { usuario: null, modo: 'normal' };
const pedido = { id: 'a'.repeat(32), campanha: 1, premio: 'AK-47 | Bloodsport', numeros: [5, 6], total: 5.78, status: 'PENDING',
  expira_em: Date.now() + 36e5, criado_em: '2026-11-09T12:00:00.000Z', pix: { qr_code: 'FIXTURE-SEM-PAGAMENTO', qr_code_base64: null, ticket_url: null } };
const preset = { id: 1, nome: 'AK padrão', versao: 1, foto: '', atualizado_em: '2026-11-09T12:00:00.000Z',
  dados: { premio: 'AK-47 | Redline', desgaste: 'FT', descricao: 'x', valor: 100, preco_numero: 2, cor: '#b3263a', max: 10, max_por_usuario: 2, viewer_3d: viewer, reconfigurar_3d: false } };
async function api(method, rota) {
  const u = estado.usuario;
  if (rota === '/api/estado') return estado.modo === 'erro' ? { status: 503, data: { erro: 'fixture' } }
    : { data: { eu: u, naoLidas: u ? 2 : 0, pix: true, viewer3d: { key: 'pk_fixture12345678', configurado: true },
      s: { titulo: 'GOATSKINS SORTEIOS', sub: 'Fixture local.', banner: '', cores: { gold: '#d4aa55', copper: '#b8651f', slate: '#102440', navy: '#0e1a33' } }, c: campanhas() } };
  if (rota === '/api/pedidos/pendente') return { data: u ? pedido : null };
  if (rota.startsWith('/api/pedidos/')) return { data: pedido };
  if (rota === '/api/pedidos') return { data: [pedido, { ...pedido, id: 'c'.repeat(32), status: 'PAID', pix: null }] };
  if (rota === '/api/campanhas/8/verificacao') return { data: { status: 'DRAWN', commit_hash: sha(seed), seed, snapshot_hash: snapshot, metodo: 'HMAC-SHA256(semente, sha256(numeros)) mod N', sorteado_em: '2026-11-01T12:00:00.000Z', numeros: numerosProva, vencedor } };
  if (rota === '/api/conta') return { data: { id: 1, nome: u.nome, email: 'conta@goatskins.test', telefone: '+5511999999999', celular: '+5511999999999', email_verificado: 1, role: u.role } };
  if (rota === '/api/notificacoes') return { data: [{ id: 1, titulo: 'Pagamento confirmado!', texto: 'Seus números: 5, 6.', lida: 0, criado_em: '2026-11-09T12:00:00.000Z' }] };
  if (rota === '/api/mfa/status') return { data: estado.modo === 'mfa' ? { enabled: false, verified: false } : { enabled: true, verified: true } };
  if (rota === '/api/admin/dashboard') return { data: { operacao: { receita: 1234.5, pix_pendentes: 2, pix_revisao: 1, reembolsos: 0, estornos: 1, entregas: 1, prontos_para_sorteio: 1 },
    usuarios: 10, verificados: 8, sorteios: [], participacoes: 25, hoje: 3, semana: 9, porSorteio: [{ premio: 'AK', status: 'OPEN', escolhidos: 3, max: 24 }],
    ultimas: [{ criado_em: '2026-11-09T12:00:00.000Z', premio: 'AK', n: 3, nome: 'Fulano', email: 'f@goatskins.test' }] } };
  if (rota === '/api/admin/pedidos') return { data: { receita: 1234.5, pedidos: [
    { id: 'd'.repeat(32), status: 'PENDING', total: 5.78, numeros: '[5,6]', criado_em: '2026-11-09T12:00:00.000Z', premio: 'AK', nome: 'Fulano', email: 'f@goatskins.test', mp_order_id: null, revisao_pagamento: true, estorno_mp: null },
    { id: 'e'.repeat(32), status: 'REFUND_NEEDED', total: 2.89, numeros: '[7]', criado_em: '2026-11-09T12:00:00.000Z', premio: 'AK', nome: 'Beltrano', email: 'b@goatskins.test', mp_order_id: 'ORDX', revisao_pagamento: false, estorno_mp: null },
    { id: 'f'.repeat(32), status: 'PAID', total: 2.89, numeros: '[8]', criado_em: '2026-11-09T12:00:00.000Z', premio: 'AK', nome: 'Ciclano', email: 'c@goatskins.test', mp_order_id: 'ORDY', revisao_pagamento: false, estorno_mp: 'charged_back' }] } };
  if (rota === '/api/admin/ganhadores') return { data: [{ id: 8, premio: 'Realizado', n: vencedor, nome: 'Participante', email: 'p@goatskins.test', telefone: '+5511999999999', entregue_em: null }] };
  if (rota === '/api/admin/usuarios') return { data: [{ id: 2, nome: 'Fulano', email: 'f@goatskins.test', role: 'USER', status: 'ACTIVE', email_verificado: 1 }, { id: 3, nome: 'Adm', email: 'a@goatskins.test', role: 'ADMIN', status: 'SUSPENDED', email_verificado: 0 }] };
  if (rota === '/api/admin/logs') return { data: [{ quando: '2026-11-09T12:00:00.000Z', acao: 'LOGIN', email: 'f@goatskins.test', detalhe: 'x', ip: '127.0.0.1' }] };
  if (rota.startsWith('/api/admin/predefinicoes/')) return { data: preset };
  if (rota.startsWith('/api/admin/predefinicoes')) return { data: [preset] };
  if (rota === '/api/admin/campanhas/1') return { data: { id: 1, premio: 'AK-47 | Bloodsport', desgaste: 'FT', descricao: 'x', valor: 320, cor: '#b3263a', max: 24, max_por_usuario: 3, foto: '', status: 'OPEN', viewer_3d: viewer, reconfigurar_3d: false, preco_numero: 2.89 } };
  if (rota === '/api/admin/campanhas/arquivadas') return { data: [{ id: 9, premio: 'Arquivado', status: 'CLOSED', max: 10, total: 0, pedidos: 1 }] };
  return { data: [] };
}

/* ---------- coleta no navegador ---------- */
const inicializar = `localStorage.setItem('goatskins-cookies',JSON.stringify({version:1,preferences:false}));
window.__estabilizar=()=>{for(const a of document.getAnimations()){const t=a.effect&&a.effect.getComputedTiming();if(t&&t.iterations===Infinity){a.pause();a.currentTime=0;}else{try{a.finish()}catch(_){a.cancel()}}}};
window.__coletar=()=>{__estabilizar();const out={},fnv=s=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36)};
 const ser=cs=>{const nomes=[];for(let i=0;i<cs.length;i++)nomes.push(cs[i]);nomes.sort();let s='';for(const p of nomes)s+=p+':'+cs.getPropertyValue(p).split(location.origin).join('')+';';return s};
 const andar=(el,p)=>{out[p]=fnv(ser(getComputedStyle(el)));for(const pe of ['::before','::after']){const c=getComputedStyle(el,pe);if(c.content&&c.content!=='none'&&c.content!=='normal')out[p+pe]=fnv(ser(c));}
  if(el.tagName==='INPUT'||el.tagName==='TEXTAREA')out[p+'::placeholder']=fnv(ser(getComputedStyle(el,'::placeholder')));
  [...el.children].forEach((f,i)=>{if(f.tagName!=='SCRIPT'&&f.tagName!=='IFRAME')andar(f,p+'>'+f.tagName.toLowerCase()+':'+i)})};
 andar(document.body,'body');return out};
window.__detalhe=caminho=>{__estabilizar();const [p,pe]=caminho.split('::');let el=document.body;for(const parte of p.split('>').slice(1))el=el.children[Number(parte.split(':')[1])];
 const cs=getComputedStyle(el,pe?'::'+pe:null),o={};for(let i=0;i<cs.length;i++)o[cs[i]]=cs.getPropertyValue(cs[i]).split(location.origin).join('');
 return {o,desc:el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/).join('.'):'')}};`;

const estados = [
  ['home', async b => { await b.navigate('/'); }],
  ['home-ordem-preco', async b => { await b.cdp.evaluate('campaignSort.value="price-asc";campaignSort.dispatchEvent(new Event("change"))'); }],
  ['detalhe-selecao', async b => { await b.cdp.evaluate('abrirSorteio(1);document.querySelectorAll(".sale-grid .num")[4].click();document.querySelectorAll(".sale-grid .num")[5].click()'); }],
  ['detalhe-gratis', async b => { await b.cdp.evaluate('abrirSorteio(2)'); }],
  ['detalhe-encerrado', async b => { await b.cdp.evaluate('abrirSorteio(7)'); }],
  ['detalhe-realizado', async b => { await b.cdp.evaluate('abrirSorteio(8)'); }],
  ['historico', async b => { await b.cdp.evaluate('navegar("historico")'); }],
  ['auth-entrar', async b => { await b.cdp.evaluate('navegar("sorteios");authModal("entrar")'); }],
  ['auth-criar', async b => { await b.cdp.evaluate('authModal("criar")'); }],
  ['auth-esqueci', async b => { await b.cdp.evaluate('authModal("esqueci")'); }],
  ['auth-erro', async b => { await b.cdp.evaluate('authModal("entrar");document.querySelector("#modalBody form").requestSubmit()'); }],
  ['mensagem', async b => { await b.cdp.evaluate('mensagemAuth("Confira seu e-mail","Fixture.","Voltar",closeModal)'); }],
  ['cookies-banner', async b => { await b.cdp.evaluate('closeModal();document.querySelector("[data-cookie-settings]").click()'); }],
  ['logado-home', async b => { estado.usuario = { id: 1, nome: 'Conta Fixture', role: 'USER', email_verificado: 1, celular_preenchido: true }; await b.navigate('/'); await until(() => b.cdp.evaluate('!document.getElementById("pendingPixBar").hidden')); }],
  ['logado-bilhetes', async b => { await b.cdp.evaluate('navegar("bilhetes");carregarPedidos()'); await until(() => b.cdp.evaluate('document.querySelectorAll("#pedList li").length===2')); }],
  ['conta', async b => { await b.cdp.evaluate('conta()'); await until(() => b.cdp.evaluate('!!document.querySelector(".account-shell")')); }],
  ['pix', async b => { await b.cdp.evaluate('closeModal();pedidoModal(' + JSON.stringify(pedido) + ')'); }],
  ['visualizador-3d', async b => { await b.cdp.evaluate('closeModal();navegar("sorteios");abrirSorteio(1);document.querySelector(".skin-3d-button").click()'); await until(() => b.cdp.evaluate('!!document.querySelector(".skin-viewer")')); }],
  ['roleta', async b => { await b.navigate('/'); await b.cdp.evaluate('roleta(S.c.find(c=>c.id===8))'); await until(() => b.cdp.evaluate('!!document.querySelector(".roulette-screen")')); }],
  ['admin-painel', async b => { estado.usuario = { id: 1, nome: 'Admin Fixture', role: 'SUPER_ADMIN', email_verificado: 1, celular_preenchido: true }; await b.navigate('/'); await b.cdp.evaluate('painel("painel")'); await until(() => b.cdp.evaluate('!!document.querySelector(".admin-ops")')); }],
  ['admin-card', async b => { await b.cdp.evaluate('closeModal();document.querySelector("#gridAtivos .card-admin").open=true'); }],
  ['admin-sorteios', async b => { await b.cdp.evaluate('painel("sorteios")'); await until(() => b.cdp.evaluate('!!document.querySelector(".raffle-editor")')); await b.cdp.evaluate('document.querySelector(".skin-config input[type=checkbox]").click()'); }],
  ['admin-editar', async b => { await b.cdp.evaluate('painel("sorteios",S.c[0])'); await until(() => b.cdp.evaluate('!!document.querySelector(".raffle-editor .skin-sticker-list")')); }],
  ['admin-predefinicoes', async b => { await b.cdp.evaluate('painel("predefinicoes")'); await until(() => b.cdp.evaluate('!!document.querySelector(".preset-card")')); await b.cdp.evaluate('document.querySelector(".preset-details").open=true'); }],
  ['admin-pedidos', async b => { await b.cdp.evaluate('painel("pedidos")'); await until(() => b.cdp.evaluate('!!document.querySelector(".tabela")')); }],
  ['admin-entregas', async b => { await b.cdp.evaluate('painel("entregas")'); await until(() => b.cdp.evaluate('!!document.querySelector("#modalBody .arow")')); }],
  ['admin-usuarios', async b => { await b.cdp.evaluate('painel("usuarios")'); await until(() => b.cdp.evaluate('!!document.querySelector("#modalBody .arow")')); }],
  ['admin-logs', async b => { await b.cdp.evaluate('painel("logs")'); await until(() => b.cdp.evaluate('!!document.querySelector(".tabela")')); }],
  ['admin-visual', async b => { await b.cdp.evaluate('painel("visual")'); }],
  ['mfa', async b => { estado.modo = 'mfa'; await b.navigate('/'); await until(() => b.cdp.evaluate('!!document.querySelector(".mfa-dialog")')); estado.modo = 'normal'; }],
  ['erro-carregamento', async b => { estado.usuario = null; estado.modo = 'erro'; await b.cdp.send('Page.navigate', { url: b.base + '/' }); await until(() => b.cdp.evaluate('!!document.querySelector("#pageLoader.is-error")')); estado.modo = 'normal'; }],
  ['termos', async b => { await b.navigate('/termos.html'); }],
  ['privacidade', async b => { await b.navigate('/privacidade.html'); }],
  ['cookies', async b => { await b.navigate('/cookies.html'); }]
];

/* Coleta até duas leituras seguidas iguais: ResizeObserver, fontes e timers terminam de se acomodar. */
async function estavel(b) {
  let antes = null;
  for (let i = 0; i < 20; i++) {
    const agora = await b.cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>r(__coletar()),60))))');
    if (antes && JSON.stringify(agora) === JSON.stringify(antes)) return agora;
    antes = agora;
  }
  return antes;
}
async function main() {
  if (!executable) throw Error('Chrome/Edge local necessário.');
  const [A, B] = await Promise.all([startBrowser({ directory: referencia, api, initialize: inicializar }), startBrowser({ directory: path.join(root, 'public'), api, initialize: inicializar })]);
  const diferencas = []; let comparados = 0, elementos = 0;
  try {
    for (const largura of larguras) {
      for (const b of [A, B]) await b.cdp.send('Emulation.setDeviceMetricsOverride', { width: largura, height: 900, deviceScaleFactor: 1, mobile: false });
      estado.usuario = null; estado.modo = 'normal';
      for (const [nome, preparar] of estados) {
        for (const b of [A, B]) {
          await preparar(b);
          await b.cdp.evaluate('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
          await b.cdp.evaluate('document.querySelectorAll("img[loading=lazy]").forEach(i=>{i.loading="eager"})');
          await until(() => b.cdp.evaluate('[...document.images].every(i=>i.complete)'));
        }
        const [ca, cb] = await Promise.all([A, B].map(estavel));
        comparados++; elementos += Object.keys(cb).length;
        const chaves = new Set([...Object.keys(ca), ...Object.keys(cb)]);
        for (const k of chaves) {
          if (ca[k] === cb[k]) continue;
          if (!(k in ca) || !(k in cb)) { diferencas.push({ largura, estado: nome, elemento: k, problema: k in ca ? 'só na referência' : 'só no atual' }); continue; }
          const [da, db] = await Promise.all([A.cdp.evaluate('__detalhe(' + JSON.stringify(k) + ')'), B.cdp.evaluate('__detalhe(' + JSON.stringify(k) + ')')]);
          const props = Object.keys({ ...da.o, ...db.o }).filter(p => da.o[p] !== db.o[p]).map(p => p + ': ' + da.o[p] + ' -> ' + db.o[p]);
          diferencas.push({ largura, estado: nome, elemento: k, alvo: db.desc, props });
        }
        process.stdout.write((diferencas.some(d => d.estado === nome && d.largura === largura) ? 'DIF  ' : 'OK   ') + largura + ' ' + nome + '\n');
      }
    }
    const erros = [...A.pageErrors, ...B.pageErrors];
    if (erros.length) console.log('Exceções JS:', JSON.stringify(erros.slice(0, 3)).slice(0, 600));
  } finally { await A.close(); await B.close(); }
  console.log(JSON.stringify({ estadosComparados: comparados, elementosPorEstado: Math.round(elementos / comparados), diferencas: diferencas.length }));
  for (const d of diferencas.slice(0, 60)) console.log(JSON.stringify(d));
  if (diferencas.length) process.exitCode = 1;
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
