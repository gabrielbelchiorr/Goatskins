/* Interface GOATSKINS */
let S = { eu: null, naoLidas: 0, s: { titulo: "", sub: "", banner: "", cores: { gold: "#d4aa55", copper: "#b8651f", slate: "#102440", navy: "#0e1a33" } }, c: [] };
let view = "sorteios";
let sorteioAtual = null, pedidoPendente = null, buscandoPendente = false, pedidoPoll = null;
const sorteioURL = Number(new URLSearchParams(location.search).get("sorteio"));
if (Number.isInteger(sorteioURL) && sorteioURL > 0) { view = "detalhe"; sorteioAtual = sorteioURL; }

// Prévia local: null usa o sorteio real; um número simula a animação.
// Só funciona em localhost e em sorteios gratuitos; nunca grava vencedor no servidor.
const NUMERO_ESCOLHIDO_TESTE = null;
// Nome exibido somente na prévia local.
const NOME_GANHADOR_TESTE = "Fulano";

const IMG_MAX = 900; // largura máxima das fotos enviadas (px)

function $(id) { const e = document.getElementById(id); if (!e) throw new Error("id ausente: " + id); return e; }
function h(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
const fmt = iso => iso.split("-").reverse().join("/");
const dataHora = iso => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const brl = v => "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
const admin = () => !!S.eu && (S.eu.role === "ADMIN" || S.eu.role === "SUPER_ADMIN");

/* Requisições à API com o cabeçalho exigido pela proteção CSRF. */
async function api(url, method, body, mfaRetry = false) {
  const r = await fetch(url, { method: method || "GET", credentials: "same-origin", signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", "X-Requested-With": "goatskins" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && d.tipo === "TURNSTILE_REQUIRED") {
    const action = url === "/api/login" ? "login" : url === "/api/registro" ? "registro" : "recuperacao";
    const token = await desafioSeguranca(action);
    const retry = await fetch(url, {method: method || "GET", credentials:"same-origin", signal:AbortSignal.timeout(20000), headers:{"Content-Type":"application/json","X-Requested-With":"goatskins"}, body:JSON.stringify({...body,turnstileToken:token})});
    const result = await retry.json(); if(!retry.ok) throw new Error(result.erro || "Falha na verificação."); return result;
  }
  if (!r.ok && d.tipo === 'MFA_REQUIRED' && url.startsWith('/api/admin/') && !mfaRetry && admin()) {
    const retomar = retomarPainelAdmin;
    const verified = await exigirMfaAdmin();
    if (verified && (!method || method === 'GET')) {
      if (retomar) retomar();
      return api(url, method, body, true);
    }
    if (verified) {
      painel(destinoAdmin.aba, destinoAdmin.editar, 'Verificação concluída. Revise e confirme a ação novamente.');
      throw new Error('Verificação concluída. A ação anterior não foi executada; confirme novamente.');
    }
    throw new Error('Confirme a autenticação em duas etapas para acessar a administração.');
  }
  if (!r.ok) throw new Error(d.erro || (r.status === 429 ? "Muitas tentativas. Aguarde um pouco." : r.status >= 500 ? "Erro no servidor. Tente novamente em instantes." : "Erro " + r.status));
  return d;
}
async function carregar() {
  S = await api("/api/estado"); render();
  window.GoatskinsLoading?.finish();
  if (S.eu && !S.eu.celular_preenchido && !admin()) return celularModal();
  await atualizarPendente();
}

function lerFoto(file, cb) {
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, IMG_MAX / img.width), cv = document.createElement("canvas");
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      cb(cv.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => alert("Não consegui ler essa imagem.");
    img.src = r.result;
  };
  r.readAsDataURL(file);
}

/* ---------- Janela (modal) e campos ---------- */
let modalOpener = null;
let mfaPendente = null;
let destinoAdmin = {aba:'painel', editar:undefined};
let retomarPainelAdmin = null;
const modalBackground = new Map();
function openModal(wide, ...nodes) {
  if ($("modal").hidden) {
    modalOpener = document.activeElement;
    document.querySelectorAll('.hero, .shell, #menuBtn, #scrim, #pendingPixBar, .cookie-banner').forEach(el => {
      modalBackground.set(el, el.inert); el.inert = true;
    });
  }
  const b = $("modalBody"); b.innerHTML = ""; b.append(...nodes);
  b.parentElement.classList.toggle("wide", !!wide); b.parentElement.classList.remove("pix-dialog", "auth-dialog", "account-dialog", "mfa-dialog"); $("modal").hidden = false;
  const title = b.querySelector('h3');
  if (title) { title.id = 'modalTitle'; title.tabIndex = -1; b.parentElement.setAttribute('aria-labelledby', title.id); title.focus({preventScroll:true}); }
  else { b.parentElement.removeAttribute('aria-labelledby'); $("closeBtn").focus({preventScroll:true}); }
  b.parentElement.scrollTop = 0;
}
function closeModal() {
  if (mfaPendente?.busy) return;
  if (mfaPendente) {
    const pending = mfaPendente; mfaPendente = null;
    $('modalBody').replaceChildren(); pending.resolve(false);
  }
  $("modal").hidden = true;
  modalBackground.forEach((inert, el) => { el.inert = inert; }); modalBackground.clear();
  if (modalOpener?.isConnected && !modalOpener.closest('[hidden], [inert]')) modalOpener.focus({preventScroll:true});
}
document.addEventListener('keydown', e => {
  if ($('modal').hidden || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
  if (e.key !== 'Tab') return;
  const focusable = [...$('modal').querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]')]
    .filter(el => el.getClientRects().length && !el.closest('[hidden], [inert]'));
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (!first) return;
  if (e.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
});
function campo(rotulo, tipo, valor) {
  const i = h("input"); i.type = tipo; if (tipo !== "file" && valor != null) i.value = valor;
  i.id = 'campo-' + crypto.randomUUID();
  const label = h('label', null, rotulo); label.htmlFor = i.id;
  const w = h("div", "form-field"); w.append(label);
  if (tipo === "password") {
    const controle = h("div", "password-field");
    const mostrar = botao("Mostrar", "password-toggle", () => {
      const visivel = i.type === "password";
      i.type = visivel ? "text" : "password";
      mostrar.textContent = visivel ? "Ocultar" : "Mostrar";
      mostrar.setAttribute("aria-label", (visivel ? "Ocultar senha: " : "Mostrar senha: ") + rotulo);
      mostrar.setAttribute("aria-pressed", String(visivel));
    });
    mostrar.setAttribute("aria-controls", i.id);
    mostrar.setAttribute("aria-label", "Mostrar senha: " + rotulo);
    mostrar.setAttribute("aria-pressed", "false");
    controle.append(i, mostrar); w.append(controle);
  } else w.append(i);
  return { w, i };
}
async function sairDaConta() {
  if (!confirm("Tem certeza de que deseja sair da sua conta?")) return;
  await api("/api/logout", "POST");
  retomarPainelAdmin = null; destinoAdmin = {aba:'painel', editar:undefined};
  closeModal();
  await carregar();
}
function botao(texto, cls, fn) { const b = h("button", "btn" + (cls ? " " + cls : ""), texto); b.type = "button"; if (fn) b.addEventListener("click", fn); return b; }
function aviso(titulo, msg) { openModal(false, h("h3", null, titulo), h("p", null, msg)); }
function tabela(cab, linhas) {
  const t = h("table", "tabela"), tr = h("tr"); cab.forEach(c => tr.append(h("th", null, c))); t.append(tr);
  linhas.forEach(l => { const r = h("tr"); l.forEach(c => r.append(h("td", null, c == null ? "" : String(c)))); t.append(r); });
  const scroll = h("div", "table-scroll"); scroll.tabIndex = 0; scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "Tabela: " + cab.join(", ")); scroll.append(t); return scroll;
}
async function rodar(err, fn) { try { await fn(); } catch (e) { mostrarFeedback(err, e.message); } }

/* Componentes de apresentação. As rotas, os corpos e as regras do servidor são preservados. */
function mostrarFeedback(el, texto, sucesso = false) {
  el.classList.toggle('is-success', sucesso); el.setAttribute('role', sucesso ? 'status' : 'alert');
  el.textContent = texto;
}
function prepararCampo(c, op = {}, mensagemPadrao = 'Use de 8 a 100 caracteres, com letras e números.') {
  Object.assign(c.i, {required:true, ...op});
  const erro = h('span', 'field-error'); erro.id = c.i.id + '-erro'; erro.setAttribute('aria-live', 'polite');
  c.i.setAttribute('aria-describedby', erro.id); c.w.append(erro);
  const validar = () => {
    const v = c.i.validity;
    const mensagem = v.valid ? '' : v.valueMissing ? 'Preencha este campo.' : v.typeMismatch ? 'Informe um e-mail válido.' :
      v.tooShort ? 'Use pelo menos ' + c.i.minLength + ' caracteres.' : v.patternMismatch ? mensagemPadrao : 'Confira o valor informado.';
    erro.textContent = mensagem; c.i.setAttribute('aria-invalid', String(!v.valid));
    return v.valid;
  };
  c.i.addEventListener('blur', () => { if (c.i.value) validar(); });
  c.i.addEventListener('input', () => { if (c.i.getAttribute('aria-invalid') === 'true') validar(); });
  c.i.addEventListener('invalid', e => { e.preventDefault(); validar(); });
  return c;
}
function formularioConta(err, ok, enviar, carregando = 'Aguarde...') {
  const form = h('form', 'account-form'); form.noValidate = true;
  err.setAttribute('role', 'alert'); err.tabIndex = -1; ok.type = 'submit';
  form.addEventListener('input', () => { if (err.classList.contains('is-success')) mostrarFeedback(err, ''); });
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (ok.disabled) return;
    if (!form.checkValidity()) {
      form.querySelector(':invalid')?.focus(); return;
    }
    const texto = ok.textContent; ok.disabled = true; ok.textContent = carregando; ok.classList.add('is-loading');
    form.setAttribute('aria-busy', 'true'); mostrarFeedback(err, '');
    try { await enviar(); }
    catch (error) { mostrarFeedback(err, error.message); if (err.isConnected) err.focus({preventScroll:true}); }
    finally { ok.disabled = false; ok.textContent = texto; ok.classList.remove('is-loading'); form.removeAttribute('aria-busy'); }
  });
  return form;
}
function dicaSenha(c) {
  const box = h('div', 'password-rules'); box.id = c.i.id + '-regras';
  const regras = [['8 a 100 caracteres', s => s.length >= 8 && s.length <= 100], ['Uma letra', s => /[a-zA-Z]/.test(s)], ['Um número', s => /\d/.test(s)]];
  regras.forEach(([texto, verificar]) => {
    const regra = h('span', null, texto); box.append(regra);
    c.i.addEventListener('input', () => regra.classList.toggle('is-met', verificar(c.i.value)));
  });
  c.i.setAttribute('aria-describedby', c.i.getAttribute('aria-describedby') + ' ' + box.id);
  return box;
}
function tituloConta(titulo, descricao, categoria = 'SUA CONTA GOATSKINS') {
  const head = h('header', 'account-heading');
  head.append(h('p', 'auth-eyebrow', categoria), h('h3', null, titulo), h('p', 'auth-description', descricao)); return head;
}
function abrirAuth(titulo, descricao, nodes, modo = '') {
  const shell = h('div', 'auth-shell'), visual = h('aside', 'auth-visual'), brand = h('div', 'auth-brand');
  visual.setAttribute('aria-label', 'GOATSKINS');
  const logo = h('img'); logo.src = 'logo-marca.webp'; logo.alt = ''; logo.width = 44; logo.height = 48;
  const wordmark = h('span', null, 'GOAT'); wordmark.append(h('b', null, 'SKINS')); brand.append(logo, wordmark);
  const copy = h('div', 'auth-visual-copy'), headline = h('h2', null, 'Seu próximo'); headline.append(h('span', null, 'capítulo no CS.'));
  copy.append(h('p', 'auth-eyebrow', 'BEM-VINDO À GOATSKINS'), headline, h('p', null, 'Escolha seus números. Acompanhe os sorteios. Viva cada resultado.'));
  const art = h('div', 'auth-art'), mascot = h('img'); mascot.src = 'mascote.webp'; mascot.alt = ''; mascot.width = 720; mascot.height = 984;
  art.setAttribute('aria-hidden', 'true'); art.append(mascot);
  visual.append(brand, copy, art, h('p', 'auth-visual-footer', 'SKINS DE CS. PERSONALIDADE GOAT.'));
  const panel = h('section', 'auth-panel');
  const mobileBrand = brand.cloneNode(true); mobileBrand.classList.add('auth-mobile-brand'); panel.append(mobileBrand);
  if (modo === 'entrar' || modo === 'criar') {
    const nav = h('nav', 'auth-nav'); nav.setAttribute('aria-label', 'Acesso à conta');
    [['entrar', 'Login'], ['criar', 'Cadastro']].forEach(([key, label]) => {
      const bt = botao(label, '', () => authModal(key)); bt.className = 'auth-tab';
      if (key === modo) bt.setAttribute('aria-current', 'page'); nav.append(bt);
    }); panel.append(nav);
  }
  panel.append(tituloConta(titulo, descricao, modo === 'criar' ? 'FAÇA PARTE' : modo === 'entrar' ? 'BOM TER VOCÊ DE VOLTA' : 'ACESSO E SEGURANÇA'), ...nodes);
  const foot = h('p', 'auth-legal');
  const termos = h('a', null, 'Termos de uso'), privacidade = h('a', null, 'Privacidade');
  termos.href = '/termos.html'; privacidade.href = '/privacidade.html';
  [termos, privacidade].forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  foot.append(termos, h('span', null, '·'), privacidade); panel.append(foot);
  shell.append(visual, panel); openModal(false, shell); $('modalBody').parentElement.classList.add('auth-dialog');
}
function mensagemAuth(titulo, mensagem, textoAcao, acao, sucesso = true) {
  const icon = h('div', 'auth-result' + (sucesso ? ' is-success' : ''), sucesso ? '✓' : '!'); icon.setAttribute('aria-hidden', 'true');
  const bt = botao(textoAcao, 'auth-primary', acao);
  abrirAuth(titulo, mensagem, [icon, bt], 'resultado');
}

/* A autorização administrativa é sempre confirmada pelo servidor. Segredos e
   códigos de recuperação permanecem apenas neste modal, sem armazenamento web. */
function exigirMfaAdmin() {
  if (!admin()) return Promise.resolve(false);
  if (mfaPendente) return mfaPendente.promise;
  let resolver;
  const pending = {promise:new Promise(resolve => { resolver = resolve; }), resolve:resolver};
  mfaPendente = pending;
  const ativo = () => mfaPendente === pending;
  const terminar = () => {
    if (!ativo()) return;
    mfaPendente = null; $('modalBody').replaceChildren(); closeModal(); pending.resolve(true);
  };
  const abrir = (titulo, descricao, nodes) => {
    if (!ativo()) return;
    abrirAuth(titulo, descricao, nodes, 'mfa');
    $('modalBody').parentElement.classList.add('mfa-dialog');
  };
  const sair = () => {
    const row = h('div', 'auth-switch'), err = h('p', 'err');
    row.append(botao('Cancelar', 'link', closeModal), botao('Sair da conta', 'link', () => { if (!pending.busy) rodar(err, sairDaConta); }), err);
    return row;
  };
  const copiar = async (texto, status, input) => {
    try { await navigator.clipboard.writeText(texto); mostrarFeedback(status, 'Copiado. Guarde em um local seguro.', true); }
    catch (_) {
      input?.focus(); input?.select();
      mostrarFeedback(status, input ? 'Selecione e copie a chave manualmente.' : 'Use Baixar códigos ou copie os códigos exibidos.');
    }
  };
  const recuperacao = codes => {
    if (!ativo()) return;
    const box = h('section', 'mfa-recovery'), list = h('ul', 'mfa-recovery-list');
    const status = h('p', 'err'); status.setAttribute('role', 'status');
    codes.forEach(code => list.append(h('li', null, code)));
    const texto = 'GOATSKINS — códigos de recuperação do administrador\n\n' + codes.join('\n') + '\n\nCada código pode ser usado uma única vez. Guarde este arquivo em um local seguro.\n';
    const actions = h('div', 'mfa-actions');
    actions.append(botao('Copiar códigos', 'alt', () => copiar(texto, status)), botao('Baixar códigos', 'alt', () => {
      const url = URL.createObjectURL(new Blob([texto], {type:'text/plain;charset=utf-8'}));
      const a = h('a'); a.href = url; a.download = 'goatskins-recuperacao-mfa.txt';
      a.hidden = true; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      mostrarFeedback(status, 'Arquivo solicitado. Confira o download e guarde em um local seguro.', true);
    }));
    const confirm = h('input'); confirm.type = 'checkbox';
    const label = h('label', 'check'); label.append(confirm, h('span', null, 'Guardei meus códigos de recuperação em um local seguro.'));
    const next = botao('Continuar para a administração', 'auth-primary', terminar); next.disabled = true;
    confirm.addEventListener('change', () => { next.disabled = !confirm.checked; });
    box.append(h('p', 'mfa-important', 'Estes códigos são exibidos uma única vez. Cada um substitui o código do aplicativo em uma emergência.'), list, actions, status, label, next);
    abrir('Guarde seus códigos', 'Autenticação em duas etapas ativada. Salve seus códigos antes de continuar.', [box]);
  };
  const desafio = (status, configuracao) => {
    if (!ativo()) return;
    const pw = prepararCampo(campo('Senha da conta', 'password'), {autocomplete:'current-password', maxLength:100});
    const code = prepararCampo(campo('Código do aplicativo', 'text'), {autocomplete:'one-time-code', inputMode:'numeric', minLength:6, maxLength:6, pattern:'[0-9]{6}', placeholder:'000000'}, 'Informe o código completo, conforme exibido.');
    code.w.classList.add('code-field'); code.i.spellcheck = false; code.i.autocapitalize = 'none';
    const err = h('p', 'err'), ok = botao(configuracao ? 'Ativar autenticação em duas etapas' : 'Confirmar acesso', 'auth-primary');
    let usarRecuperacao = false;
    const form = formularioConta(err, ok, async () => {
      let resposta;
      pending.busy = true; $('closeBtn').disabled = true;
      try { resposta = await api('/api/mfa/verificar', 'POST', {senha:pw.i.value, codigo:code.i.value}); }
      finally { pending.busy = false; $('closeBtn').disabled = false; pw.i.value = ''; code.i.value = ''; }
      if (!ativo()) return;
      if (configuracao) {
        if (!Array.isArray(resposta.recoveryCodes) || resposta.recoveryCodes.length !== 8) throw new Error('A ativação não retornou os códigos de recuperação. Contate o responsável pela plataforma antes de continuar.');
        recuperacao(resposta.recoveryCodes);
      } else terminar();
    }, 'Verificando...');
    code.i.addEventListener('input', () => {
      code.i.value = usarRecuperacao ? code.i.value.replace(/[^a-fA-F0-9-]/g, '').slice(0,35) : code.i.value.replace(/\D/g, '').slice(0,6);
    });
    if (configuracao) {
      const setup = h('div', 'mfa-setup'), img = h('img', 'mfa-qr');
      if (typeof configuracao.qrCode !== 'string' || !/^data:image\/(?:png|gif|svg\+xml);(?:base64|charset=utf-8),/i.test(configuracao.qrCode)) throw new Error('Não foi possível carregar o QR Code. Tente novamente.');
      img.src = configuracao.qrCode; img.width = img.height = 208; img.alt = 'QR Code para adicionar a conta GOATSKINS ao aplicativo autenticador';
      const key = campo('Chave para configuração manual', 'text', configuracao.secret);
      key.i.readOnly = true; key.i.autocomplete = 'off'; key.i.spellcheck = false; key.i.classList.add('mfa-secret');
      const copyStatus = h('p', 'err'), manual = h('div', 'mfa-manual');
      manual.append(key.w, h('p', 'field-hint', 'TOTP · 6 dígitos · 30 segundos · SHA-1'), botao('Copiar chave', 'alt', () => copiar(key.i.value, copyStatus, key.i)), copyStatus);
      setup.append(img, manual);
      form.append(h('p', 'field-hint', 'Adicione uma conta no Google Authenticator ou Microsoft Authenticator usando o QR Code ou a chave manual.'), setup,
        h('p', 'field-hint', 'Depois, confirme sua senha e o código atual do aplicativo. Esta configuração expira em 10 minutos.'));
    } else {
      const switcher = botao('Usar código de recuperação', 'link', () => {
        usarRecuperacao = !usarRecuperacao; code.i.value = ''; code.i.removeAttribute('aria-invalid');
        code.w.querySelector('.field-error').textContent = '';
        code.w.querySelector('label').textContent = usarRecuperacao ? 'Código de recuperação' : 'Código do aplicativo';
        code.i.removeAttribute('minlength'); code.i.removeAttribute('maxlength');
        Object.assign(code.i, {inputMode:usarRecuperacao ? 'text' : 'numeric', minLength:usarRecuperacao ? 32 : 6, maxLength:usarRecuperacao ? 35 : 6, pattern:usarRecuperacao ? '(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{8}){3})' : '[0-9]{6}', placeholder:usarRecuperacao ? 'XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX' : '000000'});
        code.w.classList.toggle('mfa-recovery-field', usarRecuperacao);
        switcher.textContent = usarRecuperacao ? 'Usar aplicativo autenticador' : 'Usar código de recuperação';
        mostrarFeedback(err, ''); code.i.focus();
      });
      form.append(h('p', 'field-hint', 'Use o código atual do seu aplicativo. Códigos já utilizados não podem ser reutilizados.'), switcher);
      if (status.remainingRecoveryCodes <= 2) form.append(h('p', 'mfa-important', 'Códigos de recuperação restantes: ' + status.remainingRecoveryCodes + '. Mantenha o acesso ao seu aplicativo autenticador.'));
    }
    form.append(pw.w, code.w, err, ok);
    abrir(configuracao ? 'Conecte seu autenticador' : 'Confirme seu acesso', configuracao ? 'Proteja a administração com uma segunda etapa de verificação.' : 'A administração exige sua senha e um código do autenticador ou de recuperação.', [form, sair()]);
  };
  const preparar = status => {
    const pw = prepararCampo(campo('Senha da conta', 'password'), {autocomplete:'current-password', maxLength:100});
    const err = h('p', 'err'), ok = botao('Configurar autenticador', 'auth-primary');
    const form = formularioConta(err, ok, async () => {
      let dados;
      try { dados = await api('/api/mfa/preparar', 'POST', {senha:pw.i.value}); }
      finally { pw.i.value = ''; }
      desafio(status, dados);
    }, 'Preparando configuração...');
    form.append(h('p', 'mfa-important', 'Esta configuração é obrigatória para todos os administradores. Tenha seu celular e um aplicativo autenticador por perto.'), pw.w, err, ok);
    abrir('Proteja sua administração', 'Confirme sua senha para configurar a autenticação em duas etapas. Compatível com Google Authenticator e Microsoft Authenticator.', [form, sair()]);
  };
  const consultar = async () => {
    try {
      const status = await api('/api/mfa/status');
      if (!ativo()) return;
      if (status.verified) { mfaPendente = null; pending.resolve(true); return; }
      if (status.enabled) desafio(status); else preparar(status);
    } catch (error) {
      if (!ativo()) return;
      const err = h('p', 'err', error.message);
      abrir('Verificação indisponível', 'O acesso administrativo permanece protegido. Tente novamente ou peça ao responsável pela plataforma para verificar a configuração de MFA.', [err, botao('Tentar novamente', 'auth-primary', consultar), sair()]);
    }
  };
  consultar(); return pending.promise;
}

/* ---------- Aparência vinda do servidor ---------- */
function aplicarAparencia() {
  const s = S.s, root = document.documentElement.style;
  // Paletas antigas eram muito claras no fundo; migramos SOMENTE a exibição para um azul profundo.
  // Cores personalizadas pelo administrador continuam funcionando normalmente.
  const corAnterior = String(s.cores.slate || "").toLowerCase();
  if (corAnterior === "#1f47e6" || corAnterior === "#3d4556") s.cores.slate = "#102440";
  root.setProperty("--gold", s.cores.gold); root.setProperty("--copper", s.cores.copper);
  root.setProperty("--slate", s.cores.slate); root.setProperty("--site-bg", s.cores.slate);
  root.setProperty("--navy", s.cores.navy);
  root.setProperty("--navy2", "color-mix(in srgb, " + s.cores.navy + " 82%, white)");
  $("heroTitle").textContent = s.titulo; $("heroSub").textContent = s.sub;
  const hero = $("inicio");
  hero.classList.toggle("has-banner", !!s.banner);
  hero.style.backgroundImage = s.banner ? 'linear-gradient(rgba(7,11,22,.5),rgba(7,11,22,.75)), url("' + s.banner + '")' : ""; // sem banner: volta ao fundo padrão do CSS
}

/* ---------- Telas ---------- */
const cheio = c => c.total >= c.max;
function navegar(novaView) {
  sorteioAtual = null; view = novaView;
  const u = new URL(location.href); u.searchParams.delete("sorteio");
  history.pushState({}, "", u.pathname + u.search);
  render(); window.scrollTo(0, 0);
}
function abrirSorteio(id) {
  const c = S.c.find(x => x.id === id); if (!c) return;
  sorteioAtual = id; view = "detalhe";
  history.pushState({}, "", "?sorteio=" + encodeURIComponent(id));
  render(); window.scrollTo(0, 0);
}
function cardSorteio(c) {
  const pct = Math.round(Math.min(100, c.total / c.max * 100)), restante = c.max_por_usuario - c.meus.length, fechado = c.status !== "OPEN" || cheio(c);
  const card = h("article", "card"), prize = h("button", "prize");
  prize.type = "button"; prize.setAttribute("aria-label", (c.ganhador ? "Ver resultado de " : "Ver sorteio ") + c.premio);
  prize.addEventListener("click", () => c.ganhador ? roleta(c) : abrirSorteio(c.id));
  if (c.foto) { prize.classList.add("photo"); const im = h("img"); im.src = c.foto; im.alt = c.premio; im.loading = "lazy"; prize.append(im); }
  else { prize.textContent = c.premio; prize.style.backgroundColor = c.cor; }
  if (c.valor) prize.append(h("span", "chip", "Skin " + brl(c.valor)));
  if (fechado) prize.append(h("span", "badge", c.ganhador ? "Sorteio realizado" : cheio(c) ? "100% preenchido" : "Inscrições encerradas"));
  const info = h("div", "info");
  info.append(h("h3", null, c.premio));
  if (c.desgaste) info.append(h("p", "muted", c.desgaste));
  if (c.descricao) info.append(h("p", "muted", c.descricao));
  if (c.ganhador) {
    const w = c.ganhador;
    info.append(h("p", null, "Ganhador(a): " + w.nome + " · Nº " + w.n + (w.eu ? " (você!)" : "")),
      h("p", "muted", "Realizado em " + fmt(w.data)),
      botao("Ver resultado", "alt buy-btn", () => roleta(c)));
    card.append(prize, info); return card;
  }
  if (c.preco > 0) info.append(h("p", "price", "Cada número: " + brl(c.preco)));
  const bar = h("div", "bar"), fill = h("span"); fill.style.width = pct + "%"; bar.append(fill);
  info.append(bar, h("p", "muted", c.total + " de " + c.max + " números " + (c.preco > 0 ? "vendidos" : "escolhidos") + " · " + pct + "%" + (c.reservados.length ? " · " + c.reservados.length + " reservado(s)" : "")));
  const btn = botao(fechado ? "Ver sorteio encerrado" : restante <= 0 ? "Ver meus números" : "Ver sorteio e escolher números", "", () => abrirSorteio(c.id));
  btn.classList.add("buy-btn"); info.append(btn);
  if (admin()) {
    if (fechado && c.total > 0) info.append(botao("Girar roleta", "alt", () => roleta(c)));
    if (!fechado) info.append(botao("Encerrar inscrições", "alt sale-close-btn", async () => { if (confirm("Encerrar as inscrições de " + c.premio + "?")) { try { await api("/api/admin/campanhas/" + c.id + "/encerrar", "POST"); await carregar(); } catch (e) { alert(e.message); } } }));
    info.append(botao("Editar", "alt sale-edit-btn", () => painel("sorteios", c)));
  }
  card.append(prize, info); return card;
}
function preencher(gid, nid, lista) {
  const g = $(gid); g.innerHTML = ""; lista.forEach(c => g.append(cardSorteio(c))); $(nid).hidden = lista.length > 0;
}

function render() {
  aplicarAparencia();
  const pend = S.c.filter(c => !c.ganhador);
  const realizados = S.c.filter(c => c.ganhador).sort((a, b) => b.ganhador.data.localeCompare(a.ganhador.data) || b.id - a.id);
  const ativos = pend.filter(c => c.status === "OPEN" && !cheio(c));
  preencher("gridAtivos", "noAtivos", ativos);
  const hs = $("heroStats"); hs.innerHTML = "";
  [[ativos.length, "sorteios ativos"], [S.c.filter(c => c.ganhador).length, "sorteios realizados"]]
    .forEach(([n, t]) => { const d = h("div", "hchip"); d.append(h("b", null, String(n)), h("span", null, t)); hs.append(d); });
  preencher("gridEsgotados", "noEsgotados", pend.filter(c => c.status !== "OPEN" || cheio(c)));
  preencher("gridRealizados", "noRealizados", realizados);

  const hl = $("histList"); hl.innerHTML = "";
  realizados.forEach(c => {
    const w = c.ganhador, li = h("li", "hrow");
    if (c.foto) { const im = h("img"); im.src = c.foto; im.alt = ""; li.append(im); }
    const t = h("div");
    t.append(h("b", null, c.premio), h("p", "muted", (c.valor ? brl(c.valor) + " · " : "") + fmt(w.data) + " · " + w.total + " participantes"),
      h("p", null, "Ganhador(a): " + w.nome + " · Nº " + w.n + (w.eu ? " (você!)" : "")),
      botao("Ver resultado", "alt", () => roleta(c)));
    li.append(t); hl.append(li);
  });
  $("noHist").hidden = S.c.some(c => c.ganhador);

  const tl = $("ticketsList"); tl.innerHTML = ""; let tot = 0;
  S.c.forEach(c => {
    if (!c.meus.length) return; tot++;
    const st = c.ganhador ? (c.ganhador.eu ? "Você ganhou!" : "Sorteio encerrado") : c.status !== "OPEN" || cheio(c) ? "Aguardando a roleta" : "Participando · " + c.total + "/" + c.max + " números";
    const li = h("li", "hrow"), t = h("div");
    t.append(h("b", null, c.premio), h("p", null, "Seus números: " + c.meus.join(", ")), h("p", "muted", st)); li.append(t); tl.append(li);
  });
  $("noTickets").textContent = S.eu ? "Você ainda não participa de nenhum sorteio." : "Entre na sua conta para ver seus bilhetes.";
  $("noTickets").hidden = tot > 0;

  $("loginBtn").textContent = S.eu ? "Sair (" + S.eu.nome.split(" ")[0] + ")" : "Entrar / Cadastrar";
  $("contaBtn").hidden = !S.eu; $("contaBtn").textContent = "Minha conta" + (S.naoLidas ? " (" + S.naoLidas + ")" : "");
  $("adminBtn").hidden = !admin();
  const f = $("faixa"); f.innerHTML = "";
  f.hidden = !(S.eu && !S.eu.email_verificado);
  if (!f.hidden) f.append(botao("Confirmar e-mail", "", verificarEmailModal));
  if (view === "detalhe") {
    const c = S.c.find(x => x.id === sorteioAtual);
    if (c) renderDetalhe(c);
    else { sorteioAtual = null; view = "sorteios"; }
  }
  document.querySelectorAll(".view").forEach(v => { v.hidden = v.dataset.view !== view; });
  $("inicio").hidden = false; document.body.classList.remove("sem-hero");
  document.querySelectorAll(".nv[data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === view));
}

/* ---------- Página exclusiva da skin ---------- */
function renderDetalhe(c) {
  const root = $("saleDetail"); root.innerHTML = "";
  const aberto = c.status === "OPEN" && !cheio(c), restante = Math.max(0, c.max_por_usuario - c.meus.length);
  const voltar = botao("← Voltar aos sorteios", "alt", () => navegar("sorteios")); voltar.classList.add("sale-back");
  const top = h("div", "sale-hero"), visual = h("div", "sale-art"), infos = h("div", "sale-overview");
  if (c.foto) { const im = h("img"); im.src = c.foto; im.alt = c.premio; visual.append(im); }
  else { visual.append(h("span", "sale-fallback", "✦")); visual.style.background = c.cor; }
  infos.append(h("span", "sale-eyebrow", "GOATSKINS / SORTEIO #" + c.id), h("h1", null, c.premio));
  if (c.desgaste) infos.append(h("p", "sale-wear", c.desgaste));
  if (c.descricao) infos.append(h("p", "muted", c.descricao));
  const specs = h("div", "sale-specs");
  [["VALOR DA COTA", brl(c.preco)], ["DISPONÍVEIS", String(Math.max(0,c.max-c.total-c.reservados.length))], ["PARTICIPAÇÕES", c.total + " / " + c.max]].forEach(([k,v]) => {
    const s = h("div", "sale-spec"); s.append(h("small", null, k), h("strong", null, v)); specs.append(s);
  });
  const barra = h("div", "sale-progress"), dentro = h("span"); dentro.style.width = Math.round(100*c.total/c.max) + "%";
  barra.append(dentro); infos.append(specs,barra,h("p","muted",Math.round(100*c.total/c.max)+"% preenchido · "+c.reservados.length+" reservado(s) aguardando Pix"));
  top.append(visual,infos); root.append(voltar,top);
  if (c.ganhador) root.append(botao("Ver resultado do sorteio", "alt", () => roleta(c)));
  else if (admin() && !aberto && c.total > 0) root.append(botao("Abrir roleta", "", () => roleta(c)));
  const area = h("section","sale-numbers");
  const areaHead = h("div","sale-numbers-head");
  areaHead.append(h("div",null),h("div","sale-legend","● Livre     ◉ Selecionado     ◈ Reservado     ✓ Vendido"));
  areaHead.firstChild.append(h("span","sale-eyebrow","ESCOLHA A SUA SORTE"),h("h2",null,"Selecione seus números"));
  area.append(areaHead);
  if (!aberto || !restante) {
    const texto = !aberto ? "Este sorteio não está aceitando novos números." : "Você já atingiu seu limite de números neste sorteio.";
    area.append(h("p","muted",texto));
  }
  const sel = new Set(), grade = h("div","sale-grid"), err = h("p","err");
  const checkout = h("div","sale-checkout"), resumo = h("div","sale-checkout-total"), finalizar = botao(c.preco > 0 ? "GARANTIR NÚMEROS · PIX" : "CONFIRMAR NÚMEROS");
  finalizar.classList.add("sale-pay-btn");
  const botoes = [];
  function atualizar() {
    for (const [n,b] of botoes) { b.classList.toggle("on",sel.has(n)); b.setAttribute("aria-pressed",String(sel.has(n))); }
    resumo.replaceChildren(h("small",null,sel.size+" NÚMERO(S) SELECIONADO(S)"),h("strong",null,brl(c.preco*sel.size)));
    finalizar.disabled = !sel.size || !aberto || !restante;
  }
  const disponiveis = [];
  for(let n=1;n<=c.max;n++) {
    const b=h("button","num",String(n).padStart(2,"0")); b.type="button";
    if (c.meus.includes(n)) {b.classList.add("mine"); b.title="Seu número"; b.disabled=true;}
    else if(c.ocupados.includes(n)) {b.classList.add("sold");b.title="Vendido";b.disabled=true;}
    else if(c.reservados.includes(n)) {b.classList.add("res");b.title="Reservado";b.disabled=true;}
    else { disponiveis.push(n); if(!aberto || !restante) b.disabled=true; else b.addEventListener("click",()=>{
      if(sel.has(n))sel.delete(n);else if(sel.size<restante)sel.add(n);atualizar();
    }); }
    botoes.push([n,b]);grade.append(b);
  }
  if (aberto && restante) {
    const random = h("div","sale-random"); random.append(h("span",null,"SELEÇÃO RÁPIDA"));
    [1,3,5,10].forEach(n=>random.append(botao("+"+n,"alt",()=>{
      // Amostragem sem repetição; nunca escolhe um número reservado/vendido.
      const possiveis = disponiveis.filter(x=>!sel.has(x));
      for(let i=possiveis.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));[possiveis[i],possiveis[k]]=[possiveis[k],possiveis[i]];}
      possiveis.slice(0,Math.max(0,Math.min(n,restante-sel.size))).forEach(x=>sel.add(x));atualizar();
    })));
    random.append(botao("Limpar","alt",()=>{sel.clear();atualizar();}));area.append(random);
  }
  area.append(grade,err);
  if (aberto && restante) {
    checkout.append(resumo,finalizar);area.append(checkout);
    finalizar.addEventListener("click",()=>rodar(err,async()=>{
      if (!S.eu) return authModal("entrar");
      if (!S.eu.email_verificado) return verificarEmailModal();
      if (!sel.size) return;
      const nums=[...sel].sort((a,b)=>a-b); finalizar.disabled=true; finalizar.textContent="PROCESSANDO...";
      try {
        if (c.preco>0) {
          const pedido=await api("/api/campanhas/"+c.id+"/pedidos","POST",{numeros:nums});
          await carregar(); pedidoModal(pedido);
        } else {
          const r=await api("/api/campanhas/"+c.id+"/numeros","POST",{numeros:nums});
          await carregar(); aviso("Participação confirmada!","Seus números: "+r.numeros.join(", "));
        }
      } catch(e) {err.textContent=e.message; finalizar.disabled=false;finalizar.textContent=c.preco>0?"GARANTIR NÚMEROS · PIX":"CONFIRMAR NÚMEROS";}
    }));
  }
  atualizar();root.append(area);
}

/* ---------- Conta: entrar, cadastrar, recuperar senha ---------- */
function authModal(modo, emailInicial = "") {
  const criar = modo === "criar", esq = modo === "esqueci", reset = modo && modo.startsWith("reset:");
  const nome = campo("Nome completo", "text"), email = campo("E-mail", "email", emailInicial), tel = campo("Celular com DDD", "tel");
  const pw = campo(reset ? "Nova senha" : "Senha", "password"), err = h("p", "err");
  mascaraCelular(tel.i);
  prepararCampo(nome, {autocomplete:'name', minLength:2, maxLength:80, placeholder:'Como podemos chamar você?'});
  prepararCampo(email, {autocomplete:'email', maxLength:120, placeholder:'voce@exemplo.com'}); email.i.autocapitalize = 'none'; email.i.spellcheck = false;
  prepararCampo(tel, {placeholder:'(11) 99999-9999'});
  prepararCampo(pw, {autocomplete:criar || reset ? 'new-password' : 'current-password', maxLength:100, placeholder:criar || reset ? 'Crie uma senha segura' : 'Sua senha'});
  if (criar || reset) { pw.i.minLength = 8; pw.i.pattern = '(?=.*[a-zA-Z])(?=.*[0-9]).{8,100}'; }
  const ck1 = h("input"), ck2 = h("input"); ck1.type = ck2.type = "checkbox";
  ck1.required = ck2.required = true;
  [ck1, ck2].forEach(ck => {
    ck.addEventListener('invalid', () => { ck.setAttribute('aria-invalid', 'true'); mostrarFeedback(err, 'Confirme a idade e aceite os termos e a política de privacidade.'); });
    ck.addEventListener('change', () => ck.removeAttribute('aria-invalid'));
  });
  const l1 = h("label", "check"), l2 = h("label", "check"), termos = h("span"), a1 = h("a", null, "Termos de uso"), a2 = h("a", null, "Política de privacidade");
  a1.href = "/termos.html"; a2.href = "/privacidade.html"; a1.target = a2.target = "_blank"; a1.rel = a2.rel = "noopener";
  termos.append("Li e aceito os ", a1, " e a ", a2, "."); l1.append(ck1, h("span", null, "Tenho 18 anos ou mais.")); l2.append(ck2, termos);
  const dica = dicaSenha(pw);
  const ok = botao(criar ? "Criar conta" : esq ? "Enviar link" : reset ? "Salvar nova senha" : "Entrar", 'auth-primary');
  const enviar = async () => {
    if (esq) { await api("/api/esqueci-senha", "POST", { email: email.i.value }); return mensagemAuth("Confira seu e-mail", "Solicitação recebida. Se existir uma conta com esse e-mail, confira a caixa de entrada e o spam. Se não chegar, tente novamente mais tarde.", 'Voltar para entrar', () => authModal('entrar', email.i.value)); }
    if (reset) { await api("/api/redefinir-senha", "POST", { token: modo.slice(6), senha: pw.i.value }); pw.i.value = ''; return mensagemAuth("Senha alterada", "Agora é só entrar com a nova senha.", 'Entrar', () => authModal('entrar')); }
    if (criar && (!ck1.checked || !ck2.checked)) throw new Error("Confirme a idade e aceite os termos e a política de privacidade.");
    const resposta = await api(criar ? "/api/registro" : "/api/login", "POST", criar ? { nome: nome.i.value, email: email.i.value, telefone: tel.i.value, senha: pw.i.value, maior18: ck1.checked, consentimento: ck2.checked } : { email: email.i.value, senha: pw.i.value });
    pw.i.value = "";
    if (resposta.pendente) {
      guardarConfirmacao({ ...resposta, email: email.i.value.trim().toLowerCase(), modo: criar ? "criar" : "entrar" });
      return confirmarCadastroModal();
    }
    closeModal(); await carregar();
    if (admin() && await exigirMfaAdmin()) painel('painel');
  };
  const form = formularioConta(err, ok, enviar, criar ? 'Criando sua conta...' : esq ? 'Enviando link...' : reset ? 'Salvando senha...' : 'Entrando...');
  const troca = h("div", 'auth-switch');
  if (!criar && !esq && !reset) {
    const recovery = h('div', 'auth-recovery'); recovery.append(botao('Esqueci minha senha', 'link', () => authModal('esqueci', email.i.value))); pw.w.append(recovery);
    troca.append(h('span', null, 'Ainda não tem uma conta?'), botao('Criar conta', 'link', () => authModal('criar')));
  } else if (criar) troca.append(h('span', null, 'Já faz parte da GOATSKINS?'), botao('Voltar para entrar', 'link', () => authModal('entrar')));
  else troca.append(botao('Voltar para entrar', 'link', () => authModal('entrar', email.i.value)));
  const campos = criar ? [nome.w, email.w, tel.w, pw.w, dica, l1, l2] : esq ? [email.w] : reset ? [pw.w, dica] : [email.w, pw.w];
  form.append(...campos, err, ok);
  const descriptions = criar ? 'Seu acesso aos sorteios começa aqui. Preencha seus dados para criar sua conta.' : esq ? 'Informe o e-mail da sua conta para receber o link de redefinição.' : reset ? 'Escolha uma nova senha para proteger o acesso à sua conta.' : 'Entre para escolher seus números e acompanhar suas participações.';
  abrirAuth(criar ? 'Criar conta' : esq ? 'Recuperar senha' : reset ? 'Nova senha' : 'Entrar', descriptions, [form, troca], modo);
}

let confirmacaoPendente = null;
try { confirmacaoPendente = JSON.parse(sessionStorage.getItem("goatskins-confirmacao") || "null"); } catch (_) { /* storage opcional */ }
function guardarConfirmacao(dados) {
  confirmacaoPendente = dados;
  try { dados ? sessionStorage.setItem("goatskins-confirmacao", JSON.stringify(dados)) : sessionStorage.removeItem("goatskins-confirmacao"); } catch (_) { /* funciona sem storage */ }
}
function confirmarCadastroModal() {
  const p = confirmacaoPendente;
  if (!p || p.cadastro_expira_em <= Date.now()) { guardarConfirmacao(null); return authModal("criar"); }
  const codigo = campo("Código de 6 dígitos", "text"), err = h("p", "err"), status = h("p", "code-status");
  codigo.i.id = "codigoCadastro"; codigo.w.querySelector("label").htmlFor = codigo.i.id;
  codigo.i.inputMode = "numeric"; codigo.i.autocomplete = "one-time-code";
  codigo.i.maxLength = 6; codigo.i.pattern = "[0-9]{6}";
  prepararCampo(codigo, {placeholder:'000000'}, 'Digite os seis dígitos do código.'); codigo.w.classList.add('code-field');
  codigo.i.addEventListener("input", () => { codigo.i.value = codigo.i.value.replace(/\D/g, "").slice(0, 6); });
  err.setAttribute("role", "alert");
  const box = h("form", "confirmacao-cadastro"); box.noValidate = true; let ocupado = false, acao = '';
  const confirmar = botao('Confirmar e-mail', 'auth-primary');
  const confirmarCodigo = async () => {
    if (ocupado || confirmar.disabled) return;
    if (!/^\d{6}$/.test(codigo.i.value)) { codigo.i.setAttribute('aria-invalid', 'true'); mostrarFeedback(err, "Digite os seis dígitos do código."); codigo.i.focus(); return; }
    ocupado = true; acao = 'confirmar'; atualizar(); mostrarFeedback(err, '');
    try {
      await api("/api/confirmar-cadastro", "POST", { token: p.token, codigo: codigo.i.value });
      guardarConfirmacao(null); await carregar();
      mensagemAuth("E-mail confirmado!", "Entre com seu e-mail e senha para participar.", 'Entrar', () => authModal('entrar', p.email));
    } catch (e) { mostrarFeedback(err, e.message); }
    finally { ocupado = false; atualizar(); }
  };
  const reenviar = botao("Reenviar código", "alt", async () => {
    if (ocupado) return;
    ocupado = true; acao = 'reenviar'; atualizar(); mostrarFeedback(err, '');
    try {
      const r = await api("/api/reenviar-verificacao", "POST", { token: p.token });
      Object.assign(p, r); guardarConfirmacao(p); codigo.i.value = "";
      mostrarFeedback(err, r.simulado ? "Modo de teste: o código está no arquivo local emails.log. Nenhum e-mail foi enviado." : "Solicitação processada. Confira seu e-mail e use apenas o código mais recente.", true);
    } catch (e) { mostrarFeedback(err, e.message); p.reenviar_em = Date.now() + 60000; guardarConfirmacao(p); }
    finally { ocupado = false; atualizar(); }
  });
  const corrigir = botao("Corrigir e-mail / reiniciar", "link", async () => {
    if (ocupado) return;
    ocupado = true; acao = 'corrigir'; atualizar();
    try { await api("/api/cancelar-cadastro", "POST", { token: p.token }); guardarConfirmacao(null); authModal(p.modo, p.email); }
    catch (e) { mostrarFeedback(err, e.message); ocupado = false; atualizar(); }
  });
  function atualizar() {
    const restante = Math.max(0, Math.ceil((p.expira_em - Date.now()) / 1000)), espera = Math.max(0, Math.ceil((p.reenviar_em - Date.now()) / 1000));
    const acabou = p.cadastro_expira_em <= Date.now();
    status.textContent = acabou ? "Solicitação expirada. Reinicie o cadastro." : restante ? "Código válido por " + Math.floor(restante / 60) + ":" + String(restante % 60).padStart(2, "0") + "." : "Código expirado. Solicite um novo código.";
    confirmar.disabled = ocupado || !restante || acabou; reenviar.disabled = ocupado || espera > 0 || acabou; corrigir.disabled = ocupado;
    confirmar.textContent = ocupado && acao === 'confirmar' ? 'Confirmando...' : 'Confirmar e-mail';
    confirmar.classList.toggle('is-loading', ocupado && acao === 'confirmar');
    box.setAttribute('aria-busy', String(ocupado));
    reenviar.textContent = ocupado && acao === 'reenviar' ? 'Enviando...' : espera ? "Reenviar em " + espera + "s" : "Reenviar código";
  }
  confirmar.type = 'submit';
  // O envio por clique e por Enter usa o mesmo handler e mantém a proteção contra duplicidade.
  box.addEventListener('submit', e => { e.preventDefault(); confirmarCodigo(); });
  const destino = h('div', 'verification-destination'); destino.append(h('span', null, 'ENDEREÇO INFORMADO'), h('strong', null, p.email));
  status.id = codigo.i.id + '-prazo'; codigo.i.setAttribute('aria-describedby', codigo.i.getAttribute('aria-describedby') + ' ' + status.id);
  box.append(destino, h("p", "muted", p.mensagem), codigo.w, status, err, confirmar, reenviar, corrigir);
  if (p.simulado) box.append(h("p", "muted", "TESTE LOCAL: código em data/emails.log; não há envio real."));
  abrirAuth('Confirme seu e-mail', 'Enviamos um código para confirmar que este e-mail é seu. Confira também a pasta de spam.', [box], 'verificar'); atualizar();
  const timer = setInterval(() => { if (!box.isConnected || $("modal").hidden) clearInterval(timer); else atualizar(); }, 1000);
}
function verificarEmailModal() { return confirmacaoPendente ? confirmarCadastroModal() : authModal("entrar"); }

/* ---------- Escolher números ---------- */
function escolherNumeros(c) {
  if (!S.eu) return authModal("entrar");
  if (!S.eu.email_verificado) return verificarEmailModal();
  const restante = c.max_por_usuario - c.meus.length, sel = new Set(), grid = h("div", "numgrid"), err = h("p", "err");
  const ok = botao(c.preco > 0 ? "Gerar Pix" : "Confirmar números"); ok.disabled = true;
  for (let n = 1; n <= c.max; n++) {
    const b = h("button", "num", String(n)); b.type = "button";
    if (c.meus.includes(n)) { b.classList.add("mine"); b.disabled = true; }
    else if (c.ocupados.includes(n)) b.disabled = true;
    else if (c.reservados.includes(n)) { b.disabled = true; b.classList.add("res"); b.title = "Reservado: aguardando pagamento"; }
    else b.addEventListener("click", () => {
      if (sel.has(n)) sel.delete(n); else if (sel.size < restante) sel.add(n);
      b.classList.toggle("on", sel.has(n)); ok.disabled = sel.size === 0; ok.textContent = sel.size ? (c.preco > 0 ? "Gerar Pix de " + brl(c.preco * sel.size) + ": " : "Confirmar: ") + [...sel].sort((x, y) => x - y).join(", ") : (c.preco > 0 ? "Gerar Pix" : "Confirmar números");
    });
    grid.append(b);
  }
  ok.addEventListener("click", async () => {
    if (ok.disabled) return; const rotulo = ok.textContent; ok.disabled = true; ok.textContent = c.preco > 0 ? "Gerando Pix..." : "Confirmando..."; err.textContent = ""; // evita clique duplo (dois pedidos)
    try {
      if (c.preco > 0) { const p = await api("/api/campanhas/" + c.id + "/pedidos", "POST", { numeros: [...sel] }); await carregar(); return pedidoModal(p); }
      const r = await api("/api/campanhas/" + c.id + "/numeros", "POST", { numeros: [...sel] }); await carregar();
      openModal(false, h("h3", null, "Você está dentro!"), h("p", "center", "Seus números em " + c.premio + ":"), h("div", "big", r.numeros.join(", ")),
        h("p", "muted center", r.completo ? "Vagas completas! O sorteio vai para a roleta em breve." : "Acompanhe em Meus bilhetes."));
    } catch (e) { err.textContent = e.message; ok.disabled = sel.size === 0; ok.textContent = rotulo; await carregar(); }
  });
  openModal(false, h("h3", null, c.premio), h("p", "muted", "Escolha até " + restante + " número(s). Riscado = indisponível" + (c.preco > 0 ? " (inclui números reservados por quem está pagando). Cada número custa " + brl(c.preco) + "." : ".")), grid, err, ok);
}

/* ---------- Pix: sessão persistente no banco, com contagem baseada no servidor ---------- */
const STATUS_PEDIDO = { PENDING: "Aguardando pagamento", PAID: "Pago", EXPIRED: "Expirado", CANCELED: "Cancelado", FAILED: "Não concluído", REFUND_NEEDED: "Reembolso em andamento", REFUNDED: "Reembolsado" };
const MSG_PEDIDO = { EXPIRED: "O prazo terminou. O sistema só libera os números depois de cancelar a cobrança no Mercado Pago.",
  CANCELED: "A cobrança foi cancelada e os números foram liberados.", FAILED: "O pagamento não foi concluído e os números foram liberados.",
  REFUND_NEEDED: "Recebemos um pagamento após o prazo e o valor precisa ser devolvido.", REFUNDED: "O valor deste pedido foi devolvido." };
const relogio = expira => {
  const segundos=Math.max(0,Math.ceil((Number(expira)-Date.now())/1000));
  return String(Math.floor(segundos/60)).padStart(2,"0")+":"+String(segundos%60).padStart(2,"0");
};
function desenharBarra() {
  const b=$("pendingPixBar"), p=pedidoPendente;
  if (!S.eu || !p || p.status!=="PENDING" || Number(p.expira_em)<=Date.now() || !p.pix) { b.hidden=true; return; }
  b.hidden=false;$("pendingPixTitle").textContent="Pagamento pendente · "+p.premio;
  $("pendingPixCountdown").textContent="PIX RESERVADO POR "+relogio(p.expira_em);
}
async function atualizarPendente() {
  if (!S.eu) {pedidoPendente=null;desenharBarra();return;}
  if (buscandoPendente) return;
  buscandoPendente=true;
  try {pedidoPendente=await api("/api/pedidos/pendente");desenharBarra();}
  catch(e) { /* mantém a barra anterior até termos resposta do servidor */ }
  finally {buscandoPendente=false;}
}
$("resumePixBtn").addEventListener("click",async()=>{
  const atual=pedidoPendente;if(!atual)return;
  try {const p=await api("/api/pedidos/"+atual.id);pedidoModal(p);}catch(e){aviso("Pagamento",e.message);}
});
setInterval(desenharBarra,1000);
setInterval(()=>{if(S.eu)atualizarPendente();},15000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&S.eu)atualizarPendente();});

function pedidoModal(p0) {
  if(pedidoPoll){clearInterval(pedidoPoll);pedidoPoll=null;}
  let p=p0;
  const box=h("div","pix-checkout"), card=h("div","pix-panel"), err=h("p","err");
  const desenhar = () => {
    card.innerHTML="";
    if (p.status==="PAID") {
      card.append(h("span","pix-success","✓ PAGAMENTO APROVADO"),h("h2",null,"Números garantidos!"),
        h("p","muted center",p.premio),h("div","big",p.numeros.join(", ")));
      if(pedidoPoll){clearInterval(pedidoPoll);pedidoPoll=null;}
      atualizarPendente();carregar().catch(()=>{});return;
    }
    if(p.status!=="PENDING") {
      card.append(h("h2",null,"Pedido "+(STATUS_PEDIDO[p.status]||p.status).toLowerCase()),
        h("p","muted center",MSG_PEDIDO[p.status]||"Verifique seus pedidos."));
      if(pedidoPoll){clearInterval(pedidoPoll);pedidoPoll=null;}
      atualizarPendente();carregar().catch(()=>{});return;
    }
    const aindaValido=Number(p.expira_em)>Date.now();
    if(!aindaValido || !p.pix) {
      card.append(h("span","pix-countdown pix-expired","◷ PRAZO DE 5 MINUTOS ENCERRADO"),
        h("h2",null,"Encerrando cobrança"),
        h("p","muted center","O pagamento está sendo conciliado com o Mercado Pago. Os números ficam protegidos até a confirmação do cancelamento ou do pagamento."));
      return;
    }
    const countdown=h("span","pix-countdown", "◷ EXPIRA EM "+relogio(p.expira_em));
    card.append(countdown,h("h2",null,"Pague agora"),h("p","pix-sub","Escaneie o QR Code para garantir seus números."));
    if(p.pix.qr_code_base64){const img=h("img","pix-qr");img.src="data:image/png;base64,"+p.pix.qr_code_base64;img.alt="QR Code Pix";card.append(img);}
    const detalhe=h("div","pix-detail");detalhe.append(h("small",null,"VOCÊ ESTÁ COMPRANDO"),h("strong",null,p.premio),
      h("p",null,"Números "+p.numeros.map(x=>"#"+String(x).padStart(2,"0")).join(" · ")),
      h("div","pix-total",brl(p.total)));card.append(detalhe);
    if(p.pix.qr_code){
      const codigo=h("input","pixcode");codigo.type="text";codigo.readOnly=true;codigo.value=p.pix.qr_code;
      const cp=botao("▣   COPIAR CÓDIGO PIX", "", async()=>{
        try {if(navigator.clipboard&&window.isSecureContext) await navigator.clipboard.writeText(codigo.value);
          else {codigo.select();if(!document.execCommand("copy"))throw new Error("Falha ao copiar");}
          cp.textContent="✓  CÓDIGO COPIADO!";
        } catch(e) {err.textContent="Não consegui copiar. Selecione o código abaixo.";codigo.focus();codigo.select();}
      });cp.classList.add("pix-copy");card.append(cp);
      const details=h("details","pix-details"),summary=h("summary",null,"Ver código Pix copia e cola");details.append(summary,codigo);card.append(details);
    }
    card.append(h("p","pix-note","O pagamento é confirmado automaticamente. Não é necessário enviar comprovante."));
    const tick=()=>{
      if(!card.isConnected)return;
      countdown.textContent="◷ EXPIRA EM "+relogio(p.expira_em);
      if(Number(p.expira_em)<=Date.now()) desenhar();
    };
    countdown.tick=tick;
  };
  box.append(card,err);desenhar();openModal(false,box);$("modalBody").parentElement.classList.add("pix-dialog");
  // Redesenha somente quando o estado muda; o contador não reinicia ao recarregar a página.
  pedidoPoll=setInterval(async()=>{
    if(!box.isConnected||$("modal").hidden){clearInterval(pedidoPoll);pedidoPoll=null;return;}
    const rel=card.querySelector(".pix-countdown");if(rel&&rel.tick)rel.tick();
  },1000);
  let chamadas=0;
  const pollStatus=setInterval(async()=>{
    if(!box.isConnected||$("modal").hidden||p.status!=="PENDING") {clearInterval(pollStatus);return;}
    try{
      const antes=p.status, antesPix=!!p.pix;
      p=++chamadas%2===0 ? await api("/api/pedidos/"+p.id+"/atualizar","POST") : await api("/api/pedidos/"+p.id);
      if(p.status!==antes||!!p.pix!==antesPix)desenhar();
      if(p.status!=="PENDING") {clearInterval(pollStatus);await atualizarPendente();}
    } catch(e) { /* falha de rede: mantém o pedido, tenta de novo na próxima consulta */ }
  },10000);
  atualizarPendente();
}
async function carregarPedidos() {
  const ul=$("pedList"), vazio=$("noPed");ul.innerHTML="";
  if(!S.eu){vazio.hidden=true;return;}
  try {
    const ps=await api("/api/pedidos");vazio.hidden=ps.length>0;
    ps.forEach(p=>{const li=h("li","hrow"), t=h("div");t.append(h("b",null,p.premio),
      h("p",null,"Números: "+p.numeros.join(", ")+" · "+brl(p.total)),
      h("p","muted",STATUS_PEDIDO[p.status]||p.status));
      if(p.status==="PENDING")t.append(botao(p.pix?"Voltar ao Pix":"Acompanhar pedido","alt",()=>pedidoModal(p)));
      li.append(t);ul.append(li);
    });
  } catch(e){vazio.hidden=true;}
}

/* ---------- Tela da roleta ----------
   A animação apresenta o vencedor do servidor. Reabrir o resultado não faz outro sorteio. */
function roleta(c) {
  const demoLocal = ["localhost", "127.0.0.1"].includes(location.hostname) && Number(c.preco) === 0 && NUMERO_ESCOLHIDO_TESTE !== null;
  try {
    if (!window.GoatskinsRoulette) throw new Error("Não foi possível carregar a roleta. Atualize a página para tentar novamente.");
    closeModal();
    window.GoatskinsRoulette.open({ campaign: c, winner: c.ganhador, preview: demoLocal,
      draw: () => demoLocal ? Promise.resolve({ n: NUMERO_ESCOLHIDO_TESTE, nome: NOME_GANHADOR_TESTE }) : api("/api/admin/campanhas/" + c.id + "/sortear", "POST"),
      recover: async () => { S = await api("/api/estado"); render(); return S.c.find(x => x.id === c.id)?.ganhador || null; },
      onComplete: () => { if (!demoLocal) return carregar(); },
      onHistory: () => navegar("historico")
    });
  } catch (e) { aviso("Não foi possível abrir a roleta", e.message); }
}

/* ---------- Minha conta ---------- */
async function conta() {
  if (!S.eu.celular_preenchido) return celularModal();
  const p = await api("/api/conta"), nome = campo("Nome", "text", p.nome), tel = campo("Celular com DDD", "tel", p.telefone || ""), err = h("p", "err");
  tel.i.value = (p.celular || p.telefone || "").replace(/^\+55/, "");
  mascaraCelular(tel.i); tel.i.dispatchEvent(new Event("input"));
  const atual = campo("Senha atual", "password"), nova = campo("Nova senha", "password"), err2 = h("p", "err"), del = campo("Senha para confirmar a exclusão", "password"), err3 = h("p", "err");
  prepararCampo(nome, {autocomplete:'name', minLength:2, maxLength:80}); prepararCampo(tel, {placeholder:'(11) 99999-9999'});
  prepararCampo(atual, {autocomplete:'current-password', maxLength:100});
  prepararCampo(nova, {autocomplete:'new-password', minLength:8, maxLength:100, pattern:'(?=.*[a-zA-Z])(?=.*[0-9]).{8,100}'});
  prepararCampo(del, {autocomplete:'current-password', maxLength:100});
  const notas = h("div", 'account-notifications'); const ns = await api("/api/notificacoes");
  if (!ns.length) notas.append(h("p", "muted", "Nenhuma notificação."));
  ns.forEach(n => { const d = h("article", 'account-notification'); d.append(h("b", null, (n.lida ? "" : "● ") + n.titulo), h('p', 'muted', n.texto), h("small", "muted", dataHora(n.criado_em))); notas.append(d); });
  if (S.naoLidas) { api("/api/notificacoes/lidas", "POST").then(() => { S.naoLidas = 0; render(); }); }
  const salvar = botao('Salvar dados'), senha = botao('Alterar senha'), excluir = botao('Excluir minha conta', 'danger-button');
  const dadosForm = formularioConta(err, salvar, async () => {
    const atualizado = await api('/api/conta', 'PUT', {nome:nome.i.value, telefone:tel.i.value}); await carregar();
    info.querySelector('strong').textContent = atualizado.nome; avatar.textContent = atualizado.nome.trim().slice(0,1).toUpperCase();
    mostrarFeedback(err, 'Dados atualizados com sucesso.', true);
  }, 'Salvando...');
  dadosForm.append(nome.w, tel.w, err, salvar);
  const senhaForm = formularioConta(err2, senha, async () => { await api('/api/conta/senha', 'POST', {atual:atual.i.value, nova:nova.i.value}); atual.i.value = nova.i.value = ''; nova.i.dispatchEvent(new Event('input')); mostrarFeedback(err2, 'Senha alterada! Outros dispositivos foram desconectados.', true); }, 'Alterando senha...');
  senhaForm.append(atual.w, nova.w, dicaSenha(nova), err2, senha);
  const excluirForm = formularioConta(err3, excluir, async () => { if (!confirm('Tem certeza? Isso não pode ser desfeito.')) return; await api('/api/conta/excluir', 'POST', {senha:del.i.value}); await carregar(); mensagemAuth('Conta excluída', 'Seus dados pessoais foram removidos.', 'Voltar aos sorteios', closeModal); }, 'Excluindo conta...');
  excluirForm.append(h('p', 'muted', 'Remove seu nome, e-mail e telefone. Esta ação não pode ser desfeita.'), del.w, err3, excluir);
  const wrapper = h('div', 'account-shell'), head = tituloConta('Minha conta', 'Gerencie seus dados, sua segurança e suas notificações.');
  const identity = h('div', 'account-identity'), avatar = h('span', 'account-avatar', p.nome.trim().slice(0,1).toUpperCase()), info = h('div');
  avatar.setAttribute('aria-hidden', 'true'); info.append(h('strong', null, p.nome), h('p', 'muted', p.email));
  const badge = h('span', 'account-status' + (p.email_verificado ? ' is-verified' : ''), p.email_verificado ? 'E-mail confirmado' : 'E-mail pendente');
  identity.append(avatar, info, badge);
  const grid = h('div', 'account-grid');
  function card(titulo, descricao, conteudo) {
    const section = h('section', 'account-card'); section.append(h('h4', null, titulo), h('p', 'muted', descricao), conteudo); return section;
  }
  grid.append(card('Dados pessoais', 'Mantenha suas informações de contato atualizadas.', dadosForm), card('Segurança', 'Uma senha forte ajuda a proteger sua conta.', senhaForm));
  const danger = h('details', 'account-danger'); danger.append(h('summary', null, 'Excluir minha conta (LGPD)'), excluirForm);
  wrapper.append(head, identity, grid, card('Notificações', 'Atualizações sobre sua conta e suas participações.', notas), danger);
  openModal(true, wrapper); $('modalBody').parentElement.classList.add('account-dialog');
}

/* ---------- Painel admin ---------- */
async function painel(aba, editar, mensagem = '') {
  destinoAdmin = {aba, editar};
  if (!await exigirMfaAdmin()) return;
  const tabs = h("div", "tabs");
  [["painel", "Painel"], ["sorteios", "Sorteios"], ["pedidos", "Pedidos"], ["entregas", "Entregas"], ["usuarios", "Usuários"], ["logs", "Logs"], ["visual", "Aparência"]].forEach(([k, nome]) =>
    tabs.append(botao(nome, k === aba ? "on" : "", () => painel(k))));
  const corpo = h("div");
  const titulo = h("h3", null, "Painel GOATSKINS");
  retomarPainelAdmin = () => openModal(true, titulo, tabs, corpo);
  retomarPainelAdmin();
  if (mensagem) { const note = h('p', 'err'); mostrarFeedback(note, mensagem, true); corpo.append(note); }
  const f = { painel: abaPainel, sorteios: abaSorteios, pedidos: abaPedidos, entregas: abaEntregas, usuarios: abaUsuarios, logs: abaLogs, visual: abaVisual }[aba];
  Promise.resolve(f(corpo, editar)).catch(e => corpo.append(h("p", "err", e.message)));
}

async function abaPainel(box) {
  const d = await api("/api/admin/dashboard");
  [["Usuários", d.usuarios], ["E-mail confirmado", d.verificados], ["Números escolhidos", d.participacoes], ["Hoje", d.hoje], ["Últimos 7 dias", d.semana]]
    .forEach(([t, v]) => { const s = h("div", "stat", t); s.prepend(h("b", null, String(v))); box.append(s); });
  box.append(h("h4", null, "Sorteios"), tabela(["Sorteio", "Status", "Escolhidos"], d.porSorteio.map(s => [s.premio, s.status, s.escolhidos + "/" + s.max])),
    h("h4", null, "Últimas escolhas"), tabela(["Quando", "Sorteio", "Nº", "Pessoa"], d.ultimas.map(u => [dataHora(u.criado_em), u.premio, u.n, u.nome + " (" + u.email + ")"])));
}

function abaSorteios(box, edit) {
  const c = edit || { premio: "", desgaste: "", descricao: "", valor: "", preco: 0, cor: "#b3263a", max: 100, max_por_usuario: 1 };
  const f = { premio: campo("Skin (ex.: AK-47 | Redline)", "text", c.premio), desgaste: campo("Desgaste (ex.: Field-Tested)", "text", c.desgaste),
    descricao: campo("Descrição", "text", c.descricao), valor: campo("Valor da skin (R$, só exibição)", "number", c.valor), preco: campo("Preço por número (R$; 0 = grátis)", "number", c.preco),
    max: campo("Números (máx. 100)", "number", c.max), mpu: campo("Números por pessoa", "number", c.max_por_usuario), cor: campo("Cor (se não tiver foto)", "color", c.cor), foto: campo("Foto da skin", "file") };
  f.foto.i.accept = "image/*"; f.preco.i.step = "0.01"; f.preco.i.min = "0";
  const par = (a, b) => { const r = h("div", "two"); r.append(a.w, b.w); return r; }, err = h("p", "err");
  const ok = botao(edit ? "Salvar alterações" : "Adicionar sorteio", "", () => {
    const d = { premio: f.premio.i.value, desgaste: f.desgaste.i.value, descricao: f.descricao.i.value, valor: f.valor.i.value, preco_numero: f.preco.i.value, max: f.max.i.value, max_por_usuario: f.mpu.i.value, cor: f.cor.i.value };
    const enviar = foto => rodar(err, async () => { if (foto !== undefined) d.foto = foto; await api(edit ? "/api/admin/campanhas/" + c.id : "/api/admin/campanhas", edit ? "PUT" : "POST", d); await carregar(); painel("sorteios"); });
    const file = f.foto.i.files[0]; file ? lerFoto(file, enviar) : enviar(undefined);
  });
  box.append(par(f.premio, f.desgaste), f.descricao.w, par(f.valor, f.preco), par(f.max, f.mpu), f.cor.w, f.foto.w, err, ok);
  if (edit) box.append(" ", botao("Excluir este sorteio", "alt", () => rodar(err, async () => {
    if (!confirm("Excluir " + c.premio + " e todos os números escolhidos?")) return; await api("/api/admin/campanhas/" + c.id, "DELETE"); await carregar(); painel("sorteios"); })));
  if (edit && c.status === "CLOSED" && c.total === 0) {
    box.append(" ", botao("Arquivar este sorteio", "alt", () => rodar(err, async () => {
      if (!confirm("Arquivar " + c.premio + "? Ele sumirá da página pública, mas os pedidos serão preservados.")) return;
      await api("/api/admin/campanhas/" + c.id + "/arquivar", "POST");
      await carregar(); painel("sorteios");
    })));
  }
  box.append(h("h4", null, "Sorteios não arquivados"));
  S.c.filter(x => x.id !== c.id || !edit).forEach(x => {
    const row = h("div", "arow"), info = h("span", null, x.premio + " (" + x.total + "/" + x.max + ", " + x.status + ")");
    row.append(info, botao("Editar", "alt", () => painel("sorteios", x)));
    if (!x.ganhador && (x.status !== "OPEN" || cheio(x)) && x.total > 0)
      row.append(botao("Abrir roleta", "alt", () => roleta(x)));
    if (x.status === "CLOSED" && x.total === 0)
      row.append(botao("Arquivar", "alt", () => {
        const errRow = h("span", "err"); row.append(errRow);
        rodar(errRow, async () => {
          if (!confirm("Arquivar " + x.premio + "? Os pedidos não serão apagados.")) return;
          await api("/api/admin/campanhas/" + x.id + "/arquivar", "POST");
          await carregar(); painel("sorteios");
        });
      }));
    box.append(row);
  });
  const archivadas = h("div"); box.append(archivadas);
  api("/api/admin/campanhas/arquivadas").then(lista => {
    if (!archivadas.isConnected) return;
    archivadas.append(h("h4", null, "Arquivados (visíveis apenas no Admin)"));
    if (!lista.length) archivadas.append(h("p", "muted", "Nenhum sorteio arquivado."));
    lista.forEach(x => {
      const row = h("div", "arow"), errRow = h("span", "err");
      row.append(h("span", null, x.premio + " · " + x.pedidos + " pedido(s) preservado(s)"),
        botao("Restaurar", "alt", () => rodar(errRow, async () => {
          if (!confirm("Restaurar " + x.premio + " para a página pública? Ele continuará encerrado.")) return;
          await api("/api/admin/campanhas/" + x.id + "/desarquivar", "POST");
          await carregar(); painel("sorteios");
        })), errRow);
      archivadas.append(row);
    });
  }).catch(e => archivadas.append(h("p", "err", "Não foi possível carregar os arquivados: " + e.message)));

}

async function abaPedidos(box) {
  const d = await api("/api/admin/pedidos"), err = h("p", "err"), st = h("div", "stat", "Receita confirmada"); st.prepend(h("b", null, brl(d.receita))); box.append(st, err);
  const revisao = d.pedidos.filter(p => p.revisao_pagamento);
  if (revisao.length) {
    box.append(h("h4", null, "Pagamentos que precisam de revisão"),
      h("p", "muted", "As reservas continuam protegidas. Confira estes pedidos no provedor antes de qualquer intervenção; a reconciliação automática continua ativa."));
    revisao.forEach(p => {
      const row = h("div", "arow");
      row.append(h("span", null, p.nome + " · " + p.premio + " · " + brl(p.total)),
        h("p", "mono", "Referência: " + p.id + " · Order: " + (p.mp_order_id || "criação ainda não confirmada")));
      box.append(row);
    });
  }
  const rb = d.pedidos.filter(p => p.status === "REFUND_NEEDED");
  if (rb.length) { box.append(h("h4", null, "Reembolsos pendentes (devolva no painel do Mercado Pago e marque aqui)")); rb.forEach(p => { const row = h("div", "arow"); row.append(h("span", null, p.nome + " · " + p.email + " · " + p.premio + " · Nº " + JSON.parse(p.numeros).join(",") + " · " + brl(p.total) + " · ref. " + (p.mp_order_id || "-")),
    botao("Marcar reembolsado", "alt", () => rodar(err, async () => { if (!confirm("Confirma que o reembolso já foi realizado no Mercado Pago?")) return; await api("/api/admin/pedidos/" + p.id + "/reembolsado", "POST"); painel("pedidos"); }))); box.append(row); }); }
  box.append(h("h4", null, "Pedidos"), tabela(["Quando", "Sorteio", "Pessoa", "Números", "Total", "Status"], d.pedidos.map(p => [dataHora(p.criado_em), p.premio, p.nome, JSON.parse(p.numeros).join(","), brl(p.total), STATUS_PEDIDO[p.status] || p.status])));
}

async function abaEntregas(box) {
  const gs = await api("/api/admin/ganhadores"), err = h("p", "err"); box.append(err);
  if (!gs.length) box.append(h("p", "muted", "Nenhum sorteio realizado ainda."));
  gs.forEach(g => { const row = h("div", "arow"); row.append(h("span", null, g.premio + " · Nº " + g.n + " · " + g.nome + " · " + (g.email || "sem e-mail") + (g.telefone ? " · " + g.telefone : "") + (g.entregue_em ? " · ENTREGUE em " + dataHora(g.entregue_em) : " · a entregar")));
    if (!g.entregue_em) row.append(botao("Marcar entregue", "alt", () => rodar(err, async () => { if (!confirm("Confirma que o prêmio de " + g.nome + " já foi entregue?")) return; await api("/api/admin/campanhas/" + g.id + "/entregar", "POST"); painel("entregas"); }))); box.append(row); });
}

async function abaUsuarios(box) {
  const us = await api("/api/admin/usuarios"), err = h("p", "err"); box.append(err);
  us.forEach(u => {
    const row = h("div", "arow"), bt = h("span");
    row.append(h("span", null, u.nome + " · " + (u.email || "sem e-mail") + " · " + u.role + " · " + u.status + (u.email_verificado ? "" : " · e-mail pendente")));
    if (u.role !== "SUPER_ADMIN" && u.id !== S.eu.id && u.status !== "DELETED") {
      const alvo = u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
      bt.append(botao(alvo === "SUSPENDED" ? "Suspender" : "Reativar", "alt", () => rodar(err, async () => { if (!confirm("Tem certeza de que deseja " + (alvo === "SUSPENDED" ? "suspender" : "reativar") + " a conta de " + u.nome + "?")) return; await api("/api/admin/usuarios/" + u.id + "/status", "PUT", { status: alvo }); painel("usuarios"); })));
      if (S.eu.role === "SUPER_ADMIN") bt.append(" ", botao(u.role === "ADMIN" ? "Tornar usuário" : "Tornar admin", "alt", () => rodar(err, async () => { if (!confirm("Tem certeza de que deseja " + (u.role === "ADMIN" ? "remover as permissões de administrador de " : "conceder permissões de administrador a ") + u.nome + "?")) return; await api("/api/admin/usuarios/" + u.id + "/papel", "PUT", { role: u.role === "ADMIN" ? "USER" : "ADMIN" }); painel("usuarios"); })));
    }
    row.append(bt); box.append(row);
  });
}

async function abaLogs(box) {
  const ls = await api("/api/admin/logs");
  box.append(tabela(["Quando", "Ação", "Quem", "Detalhe", "IP"], ls.map(l => [dataHora(l.quando), l.acao, l.email || "-", l.detalhe || "", l.ip || ""])));
}

function abaVisual(box) {
  const s = S.s, t = campo("Título do topo", "text", s.titulo), sub = campo("Texto abaixo do título", "text", s.sub);
  const ban = campo("Banner (imagem larga, de preferência 1600x600)", "file"); ban.i.accept = "image/*";
  const cor = { gold: campo("Cor de destaque", "color", s.cores.gold), copper: campo("Cor dos botões secundários", "color", s.cores.copper),
    slate: campo("Cor do fundo", "color", s.cores.slate), navy: campo("Cor dos blocos", "color", s.cores.navy) };
  const par = (a, b) => { const r = h("div", "two"); r.append(a.w, b.w); return r; }, err = h("p", "err");
  const salvar = banner => rodar(err, async () => {
    const d = { titulo: t.i.value, sub: sub.i.value, cores: { gold: cor.gold.i.value, copper: cor.copper.i.value, slate: cor.slate.i.value, navy: cor.navy.i.value } };
    if (banner !== undefined) d.banner = banner; await api("/api/admin/visual", "PUT", d); await carregar(); painel("visual");
  });
  box.append(t.w, sub.w, ban.w, par(cor.gold, cor.copper), par(cor.slate, cor.navy), err,
    botao("Salvar aparência", "", () => { const file = ban.i.files[0]; file ? lerFoto(file, salvar) : salvar(undefined); }), " ", botao("Remover banner", "alt", () => { if (confirm("Tem certeza de que deseja remover o banner?")) salvar(""); }));
}

/* ---------- Menu lateral (botão de 3 barras) ---------- */
const mobileMQ = window.matchMedia("(max-width: 820px)");
function menuAberto(aberto, guardar) {
  document.body.classList.toggle("menu-closed", !aberto);
  $("menuBtn").setAttribute("aria-expanded", String(aberto));
  $("scrim").hidden = !(aberto && mobileMQ.matches);
  if (guardar && !mobileMQ.matches && window.GoatskinsCookies?.allowsPreferences()) { try { localStorage.setItem("menu", aberto ? "1" : "0"); } catch (e) { /* sem storage: tudo bem */ } }
}
$("menuBtn").addEventListener("click", () => menuAberto(document.body.classList.contains("menu-closed"), true));
$("scrim").addEventListener("click", () => menuAberto(false));
document.addEventListener("keydown", e => { if (!e.defaultPrevented && !document.querySelector('dialog[open]') && e.key === "Escape" && mobileMQ.matches && !document.body.classList.contains("menu-closed")) menuAberto(false); });
mobileMQ.addEventListener("change", () => menuAberto(!mobileMQ.matches));
(() => { let pref = null; try { if (window.GoatskinsCookies?.allowsPreferences()) pref = localStorage.getItem("menu"); } catch (e) { /* ignora */ } menuAberto(mobileMQ.matches ? false : pref !== "0"); })();

/* ---------- Início ---------- */
$("closeBtn").addEventListener("click", closeModal);
document.querySelectorAll(".nv[data-view]").forEach(b => b.addEventListener("click", () => {
  if (mobileMQ.matches) menuAberto(false);
  navegar(b.dataset.view); if (view === "bilhetes" && !S.eu) authModal("entrar"); if (view === "bilhetes") carregarPedidos();
}));
$("loginBtn").addEventListener("click", async () => { if (S.eu) { try { await sairDaConta(); } catch (e) { aviso("Não foi possível sair", e.message); } } else if (confirmacaoPendente) confirmarCadastroModal(); else authModal("entrar"); });
$("contaBtn").addEventListener("click", () => conta().catch(e => aviso("Ops", e.message)));
$("adminBtn").addEventListener("click", () => painel("painel"));
carregar().then(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get("msg") === "email-verificado") mensagemAuth("E-mail confirmado!", "Pronto, agora você já pode participar dos sorteios.", 'Continuar', closeModal);
  else if (q.get("msg") === "link-invalido") mensagemAuth("Link inválido", "Este link antigo não é mais válido. Entre com seu e-mail e senha para solicitar um código de confirmação.", 'Entrar', () => authModal('entrar'), false);
  else {
    const tk = q.get("redefinir") || new URLSearchParams(location.hash.slice(1)).get("redefinir");
    if (tk && /^[a-f0-9]{64}$/.test(tk)) authModal("reset:" + tk);
    else if (confirmacaoPendente && !S.eu) confirmarCadastroModal();
    else if (admin()) await exigirMfaAdmin();
  }
  // Remove somente tokens e mensagens temporárias, não a URL compartilhável ?sorteio=ID.
  const limpo = new URL(location.href);
  limpo.searchParams.delete("msg"); limpo.searchParams.delete("redefinir");
  if(limpo.hash.includes("redefinir")) limpo.hash="";
  if(limpo.href!==location.href)history.replaceState(null,"",limpo.pathname+limpo.search+limpo.hash);
}).catch(() => {
  if (window.GoatskinsLoading) window.GoatskinsLoading.fail();
  else aviso("Não foi possível carregar", "A conexão demorou ou o serviço está temporariamente indisponível. Atualize a página para tentar novamente.");
});

window.addEventListener("popstate",()=>{
  const id=Number(new URLSearchParams(location.search).get("sorteio"));
  if(Number.isInteger(id)&&id>0){view="detalhe";sorteioAtual=id;}
  else{view="sorteios";sorteioAtual=null;}
  render();
});

/* Verificação Turnstile */
let turnstileScript;
async function desafioSeguranca(action) {
  const config = await api('/api/seguranca');
  if (!config.turnstileSiteKey) throw new Error('Verificação indisponível.');
  const overlay = document.createElement('dialog'), title=h('h3',null,'Verificação de segurança'), box=h('div'), err=h('p','err');
  overlay.className = 'turnstile-dialog';
  title.id = 'turnstileTitle'; overlay.setAttribute('aria-labelledby', title.id); err.setAttribute('role', 'alert');
  overlay.append(title,box,err);document.body.append(overlay);overlay.showModal();
  try {
    if (!window.turnstile) {
      if(!turnstileScript) turnstileScript=new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.onload=resolve;script.onerror=()=>reject(new Error('Não foi possível carregar a verificação.'));document.head.append(script);
      }).catch(e=>{turnstileScript=null;throw e;});
      await turnstileScript;
    }
    return await new Promise((resolve,reject)=>{
      let widget;
      const finish=(e,t)=>{if(widget!==undefined)window.turnstile.remove(widget);e?reject(e):resolve(t);};
      overlay.addEventListener('cancel',e=>e.preventDefault());
      const fechar = botao('X','alt',()=>finish(new Error('Verificação cancelada.')));
      fechar.setAttribute('aria-label','Fechar verificação de segurança');
      overlay.append(fechar);
      widget=window.turnstile.render(box,{sitekey:config.turnstileSiteKey,action,theme:'dark',size:box.getBoundingClientRect().width < 300 ? 'compact' : 'normal',callback:t=>finish(null,t),
        'error-callback':()=>{err.textContent='Falha na verificação. Feche e tente novamente.';},'expired-callback':()=>window.turnstile.reset(widget)});
    });
  } finally {overlay.close();overlay.remove();}
}
function mascaraCelular(input) {
  input.required = true; input.autocomplete = 'tel-national'; input.maxLength = 16;
  input.addEventListener('input', () => {
    const n = input.value.replace(/\D/g, '').slice(0,11);
    input.value = n.length > 2 ? '('+n.slice(0,2)+') '+n.slice(2,7)+(n.length>7?'-'+n.slice(7):'') : n;
  });
}
// A altura varia com a largura, o banner e o título configurados no painel.
new ResizeObserver(entries => {
  document.documentElement.style.setProperty('--header-height', entries[0].target.getBoundingClientRect().height + 'px');
}).observe($('inicio'));

async function celularModal() {
  const p=await api('/api/celular'),tel=campo('Celular com DDD','tel',(p.celular||'').replace(/^\+55/,''));
  mascaraCelular(tel.i);tel.i.dispatchEvent(new Event('input'));
  const err=h('p','err');err.setAttribute('role','alert');
  prepararCampo(tel, {placeholder:'(11) 99999-9999'});
  const save=botao('Salvar celular','auth-primary');
  const form=formularioConta(err,save,async()=>{await api('/api/celular','POST',{telefone:tel.i.value});closeModal();await carregar();},'Salvando celular...');
  form.append(tel.w,h('p','field-hint','Inclua o DDD e os nove dígitos do celular.'),err,save);
  const exit=h('div','auth-switch'); exit.append(botao('Sair','link',()=>rodar(err,sairDaConta)));
  abrirAuth('Concluir cadastro','Informe um celular brasileiro com DDD para participar.',[form,exit],'celular');
}
