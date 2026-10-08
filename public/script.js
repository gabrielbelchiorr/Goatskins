/* GOATSKINS – tela (conversa com o servidor pela API) */
let S = { eu: null, naoLidas: 0, s: { titulo: "", sub: "", banner: "", cores: { gold: "#d4aa55", copper: "#b8651f", slate: "#1f47e6", navy: "#0e1a33" } }, c: [] };
let view = "sorteios";
const IMG_MAX = 900; // largura máxima das fotos enviadas (px)

function $(id) { const e = document.getElementById(id); if (!e) throw new Error("id ausente: " + id); return e; }
function h(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
const fmt = iso => iso.split("-").reverse().join("/");
const dataHora = iso => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const brl = v => "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
const admin = () => !!S.eu && (S.eu.role === "ADMIN" || S.eu.role === "SUPER_ADMIN");

/* Fala com o servidor. O cabeçalho X-Requested-With é uma proteção contra ataques CSRF. */
async function api(url, method, body) {
  const r = await fetch(url, { method: method || "GET", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "goatskins" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || (r.status === 429 ? "Muitas tentativas. Aguarde um pouco." : r.status >= 500 ? "Erro no servidor. Tente novamente em instantes." : "Erro " + r.status));
  return d;
}
async function carregar() { S = await api("/api/estado"); render(); }

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
function openModal(wide, ...nodes) {
  const b = $("modalBody"); b.innerHTML = ""; b.append(...nodes);
  b.parentElement.classList.toggle("wide", !!wide); $("modal").hidden = false;
}
function closeModal() { $("modal").hidden = true; }
function campo(rotulo, tipo, valor) {
  const i = h("input"); i.type = tipo; if (tipo !== "file" && valor != null) i.value = valor;
  const w = h("div"); w.append(h("label", null, rotulo), i); return { w, i };
}
function botao(texto, cls, fn) { const b = h("button", "btn" + (cls ? " " + cls : ""), texto); b.type = "button"; if (fn) b.addEventListener("click", fn); return b; }
function aviso(titulo, msg) { openModal(false, h("h3", null, titulo), h("p", null, msg)); }
function tabela(cab, linhas) {
  const t = h("table", "tabela"), tr = h("tr"); cab.forEach(c => tr.append(h("th", null, c))); t.append(tr);
  linhas.forEach(l => { const r = h("tr"); l.forEach(c => r.append(h("td", null, c == null ? "" : String(c)))); t.append(r); }); return t;
}
async function rodar(err, fn) { try { await fn(); } catch (e) { err.textContent = e.message; } }

/* ---------- Aparência vinda do servidor ---------- */
function aplicarAparencia() {
  const s = S.s, root = document.documentElement.style;
  if (s.cores.slate === "#3d4556") s.cores.slate = "#1f47e6"; // cinza antigo (padrão anterior) -> novo azul de destaque
  root.setProperty("--gold", s.cores.gold); root.setProperty("--copper", s.cores.copper);
  root.setProperty("--slate", s.cores.slate); root.setProperty("--navy", s.cores.navy);
  root.setProperty("--navy2", "color-mix(in srgb, " + s.cores.navy + " 82%, white)");
  $("heroTitle").textContent = s.titulo; $("heroSub").textContent = s.sub;
  const hero = $("inicio");
  hero.classList.toggle("has-banner", !!s.banner);
  hero.style.backgroundImage = s.banner ? 'linear-gradient(rgba(7,11,22,.5),rgba(7,11,22,.75)), url("' + s.banner + '")' : ""; // sem banner: volta ao fundo padrão do CSS
}

/* ---------- Telas ---------- */
const cheio = c => c.total >= c.max;
function cardSorteio(c) {
  const pct = Math.round(Math.min(100, c.total / c.max * 100)), restante = c.max_por_usuario - c.meus.length, fechado = c.status !== "OPEN" || cheio(c);
  const card = h("article", "card"), prize = h("div", "prize");
  if (c.foto) { prize.classList.add("photo"); const im = h("img"); im.src = c.foto; im.alt = c.premio; im.loading = "lazy"; prize.append(im); }
  else { prize.textContent = c.premio; prize.style.backgroundColor = c.cor; }
  if (c.valor) prize.append(h("span", "chip", "Skin " + brl(c.valor)));
  if (fechado) prize.append(h("span", "badge", cheio(c) ? "100% preenchido" : "Inscrições encerradas"));
  const info = h("div", "info");
  info.append(h("h3", null, c.premio));
  if (c.desgaste) info.append(h("p", "muted", c.desgaste));
  if (c.descricao) info.append(h("p", "muted", c.descricao));
  if (c.preco > 0) info.append(h("p", "price", "Cada número: " + brl(c.preco)));
  const bar = h("div", "bar"), fill = h("span"); fill.style.width = pct + "%"; bar.append(fill);
  info.append(bar, h("p", "muted", c.total + " de " + c.max + " números " + (c.preco > 0 ? "vendidos" : "escolhidos") + " · " + pct + "%" + (c.reservados.length ? " · " + c.reservados.length + " reservado(s)" : "")));
  const btn = botao(fechado ? "Aguardando roleta" : restante <= 0 ? "Seus números: " + c.meus.join(", ") : c.preco > 0 ? "Comprar números" : "Escolher números", "", () => escolherNumeros(c));
  btn.disabled = fechado || restante <= 0; info.append(btn);
  if (admin()) {
    if (fechado && c.total > 0) info.append(botao("Girar roleta", "alt", () => roleta(c)));
    if (!fechado) info.append(botao("Encerrar inscrições", "alt", async () => { if (confirm("Encerrar as inscrições de " + c.premio + "?")) { try { await api("/api/admin/campanhas/" + c.id + "/encerrar", "POST"); await carregar(); } catch (e) { alert(e.message); } } }));
    info.append(botao("Editar", "alt", () => painel("sorteios", c)));
  }
  card.append(prize, info); return card;
}
function preencher(gid, nid, lista) {
  const g = $(gid); g.innerHTML = ""; lista.forEach(c => g.append(cardSorteio(c))); $(nid).hidden = lista.length > 0;
}

function render() {
  aplicarAparencia();
  const pend = S.c.filter(c => !c.ganhador);
  const ativos = pend.filter(c => c.status === "OPEN" && !cheio(c));
  preencher("gridAtivos", "noAtivos", ativos);
  const hs = $("heroStats"); hs.innerHTML = "";
  [[ativos.length, "sorteios ativos"], [S.c.reduce((a, c) => a + c.total, 0), "números escolhidos"], [S.c.filter(c => c.ganhador).length, "sorteios realizados"]]
    .forEach(([n, t]) => { const d = h("div", "hchip"); d.append(h("b", null, String(n)), h("span", null, t)); hs.append(d); });
  preencher("gridEsgotados", "noEsgotados", pend.filter(c => c.status !== "OPEN" || cheio(c)));

  const hl = $("histList"); hl.innerHTML = "";
  S.c.filter(c => c.ganhador).reverse().forEach(c => {
    const w = c.ganhador, li = h("li", "hrow");
    if (c.foto) { const im = h("img"); im.src = c.foto; im.alt = ""; li.append(im); }
    const t = h("div");
    t.append(h("b", null, c.premio), h("p", "muted", (c.valor ? brl(c.valor) + " · " : "") + fmt(w.data) + " · " + w.total + " participantes"),
      h("p", null, "Ganhador(a): " + w.nome + " · Nº " + w.n + (w.eu ? " (você!)" : "")), botao("Ver prova", "alt", () => prova(c)));
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
  if (!f.hidden) f.append(h("span", null, "Confirme seu e-mail para poder participar. Enviamos um link para " + S.eu.email + "."),
    botao("Reenviar", "", async () => { try { await api("/api/reenviar-verificacao", "POST"); aviso("Enviado", "Confira sua caixa de entrada (e o spam)."); } catch (e) { aviso("Ops", e.message); } }));
  document.querySelectorAll(".view").forEach(v => { v.hidden = v.dataset.view !== view; });
  $("inicio").hidden = view !== "sorteios"; document.body.classList.toggle("sem-hero", view !== "sorteios");
  document.querySelectorAll(".nv[data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === view));
}

/* ---------- Conta: entrar, cadastrar, recuperar senha ---------- */
function authModal(modo) {
  const criar = modo === "criar", esq = modo === "esqueci", reset = modo && modo.startsWith("reset:");
  const nome = campo("Nome completo", "text"), email = campo("E-mail", "email"), tel = campo("Telefone (opcional)", "tel");
  const pw = campo(reset ? "Nova senha" : "Senha", "password"), err = h("p", "err");
  pw.i.autocomplete = criar || reset ? "new-password" : "current-password";
  const ck1 = h("input"), ck2 = h("input"); ck1.type = ck2.type = "checkbox";
  const l1 = h("label", "check"), l2 = h("label", "check"), termos = h("span"), a1 = h("a", null, "Termos de uso"), a2 = h("a", null, "Política de privacidade");
  a1.href = "/termos.html"; a2.href = "/privacidade.html"; a1.target = a2.target = "_blank"; a1.rel = a2.rel = "noopener";
  termos.append("Li e aceito os ", a1, " e a ", a2, "."); l1.append(ck1, h("span", null, "Tenho 18 anos ou mais.")); l2.append(ck2, termos);
  const dica = h("p", "muted", "A senha precisa ter 8 ou mais caracteres, com letras e números.");
  const ok = botao(criar ? "Criar conta" : esq ? "Enviar link" : reset ? "Salvar nova senha" : "Entrar");
  const enviar = () => rodar(err, async () => {
    if (esq) { await api("/api/esqueci-senha", "POST", { email: email.i.value }); return aviso("Confira seu e-mail", "Se existir uma conta com esse e-mail, enviamos um link para criar uma nova senha."); }
    if (reset) { await api("/api/redefinir-senha", "POST", { token: modo.slice(6), senha: pw.i.value }); return aviso("Senha alterada", "Agora é só entrar com a nova senha."); }
    if (criar && (!ck1.checked || !ck2.checked)) throw new Error("Confirme a idade e aceite os termos e a política de privacidade.");
    await api(criar ? "/api/registro" : "/api/login", "POST", criar ? { nome: nome.i.value, email: email.i.value, telefone: tel.i.value, senha: pw.i.value, maior18: ck1.checked, consentimento: ck2.checked } : { email: email.i.value, senha: pw.i.value });
    await carregar(); closeModal();
    if (criar) aviso("Conta criada!", "Enviamos um link de confirmação para o seu e-mail. Confirme para poder participar.");
  });
  ok.addEventListener("click", enviar); pw.i.addEventListener("keydown", e => { if (e.key === "Enter") enviar(); });
  const troca = h("div"); 
  if (!criar && !esq && !reset) { const a = botao("Esqueci minha senha", "link", () => authModal("esqueci")), b = botao("Criar conta", "alt", () => authModal("criar")); a.className = "link"; troca.append(a, h("br"), b); }
  else if (!reset) troca.append(botao("Voltar para entrar", "alt", () => authModal("entrar")));
  const campos = criar ? [nome.w, email.w, tel.w, pw.w, dica, l1, l2] : esq ? [email.w] : reset ? [pw.w, dica] : [email.w, pw.w];
  openModal(false, h("h3", null, criar ? "Criar conta" : esq ? "Recuperar senha" : reset ? "Nova senha" : "Entrar"), ...campos, err, ok, troca);
}

function verificarEmailModal() {
  const err = h("p", "err");
  openModal(false, h("h3", null, "Confirme seu e-mail"), h("p", null, "Para participar, confirme o e-mail pelo link que enviamos para " + S.eu.email + "."), err,
    botao("Reenviar link", "", () => rodar(err, async () => { await api("/api/reenviar-verificacao", "POST"); err.textContent = "Link reenviado!"; })));
}

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

/* ---------- Pagamento Pix ---------- */
const STATUS_PEDIDO = { PENDING: "Aguardando pagamento", PAID: "Pago", EXPIRED: "Expirado", CANCELED: "Cancelado", FAILED: "Não concluído", REFUND_NEEDED: "Reembolso em andamento", REFUNDED: "Reembolsado" };
const MSG_PEDIDO = { EXPIRED: "O tempo para pagar acabou e os números foram liberados. Se você chegou a pagar, o sistema confirma sozinho; se os números já tiverem sido vendidos, o valor é devolvido.",
  CANCELED: "O pagamento não foi concluído e os números foram liberados.", FAILED: "O pagamento não foi concluído e os números foram liberados.",
  REFUND_NEEDED: "Recebemos o pagamento depois do prazo e os números já não estavam disponíveis. O valor será devolvido.", REFUNDED: "O valor deste pedido foi devolvido." };
function pedidoModal(p0) {
  let p = p0, timer = null, n = 0; const box = h("div"), parar = () => { clearInterval(timer); timer = null; };
  const desenhar = () => {
    box.innerHTML = "";
    if (p.status === "PAID") { box.append(h("h3", null, "Pagamento confirmado!"), h("p", "center", "Seus números em " + p.premio + ":"), h("div", "big", p.numeros.join(", ")), h("p", "muted center", "Acompanhe em Meus bilhetes.")); return parar(); }
    if (p.status !== "PENDING" || !p.pix) { box.append(h("h3", null, "Pedido " + (STATUS_PEDIDO[p.status] || "").toLowerCase()), h("p", null, MSG_PEDIDO[p.status] || "Não foi possível gerar o Pix deste pedido.")); return parar(); }
    const err = h("p", "err"), codigo = h("input", "pixcode"); codigo.readOnly = true; codigo.value = p.pix.qr_code || "";
    box.append(h("h3", null, "Pague com Pix"), h("p", null, p.premio + " · números " + p.numeros.join(", ") + " · " + brl(p.total)));
    if (p.pix.qr_code_base64) { const im = h("img", "qr"); im.src = "data:image/png;base64," + p.pix.qr_code_base64; im.alt = "QR Code do Pix"; box.append(im); }
    if (p.pix.qr_code) { const cp = botao("Copiar código Pix", "", () => { codigo.select(); (navigator.clipboard ? navigator.clipboard.writeText(codigo.value) : Promise.reject()).then(() => { cp.textContent = "Copiado!"; }, () => { document.execCommand("copy"); }); }); box.append(codigo, cp); }
    if (p.pix.ticket_url) { const a = h("a", null, "Abrir página de pagamento"); a.href = p.pix.ticket_url; a.target = "_blank"; a.rel = "noopener noreferrer"; box.append(h("p", null), a); }
    box.append(h("p", "muted", "Números reservados até " + new Date(p.expira_em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) + ". Esta tela atualiza sozinha quando o pagamento for confirmado."), err,
      botao("Já paguei", "alt", () => rodar(err, async () => { p = await api("/api/pedidos/" + p.id + "/atualizar", "POST"); desenhar(); if (p.status === "PAID") { carregar(); if (view === "bilhetes") carregarPedidos(); } })));
  };
  desenhar(); openModal(false, box);
  if (p.status === "PENDING") timer = setInterval(async () => {
    if ($("modal").hidden || !box.isConnected) return parar();
    try { n++; p = n % 3 === 0 ? await api("/api/pedidos/" + p.id + "/atualizar", "POST") : await api("/api/pedidos/" + p.id); desenhar(); if (p.status === "PAID") { carregar(); if (view === "bilhetes") carregarPedidos(); } } catch (e) { /* tenta de novo no próximo ciclo */ }
  }, 5000);
}
async function carregarPedidos() {
  const ul = $("pedList"), vazio = $("noPed"); ul.innerHTML = "";
  if (!S.eu) { vazio.hidden = true; return; }
  try {
    const ps = await api("/api/pedidos"); vazio.hidden = ps.length > 0;
    ps.forEach(p => { const li = h("li", "hrow"), t = h("div"); t.append(h("b", null, p.premio), h("p", null, "Números: " + p.numeros.join(", ") + " · " + brl(p.total)), h("p", "muted", STATUS_PEDIDO[p.status] || p.status));
      if (p.status === "PENDING" && p.pix) t.append(botao("Ver Pix", "alt", () => pedidoModal(p))); li.append(t); ul.append(li); });
  } catch (e) { vazio.hidden = true; }
}

/* ---------- Roleta (admin) ----------
   O servidor escolhe o vencedor e devolve o número. A roleta só anima até ele.
   Cada casa é um número que realmente participa do sorteio. */
function roleta(c) {
  const nums = c.ocupados, N = nums.length, SEG = 360 / N, wrap = h("div", "rwrap"), wheel = h("div", "rwheel");
  wrap.style.setProperty("--rs", "min(80vw, 380px)");
  const st = [];
  for (let i = 0; i < N; i++) st.push("hsl(" + (i * 360 / N) + ",65%," + (i % 2 ? 42 : 52) + "%) " + i * SEG + "deg " + (i + 1) * SEG + "deg");
  wheel.style.background = "conic-gradient(" + st.join(",") + ")";
  const radial = N > 20, k = Math.min(0.06, (2 * Math.PI * 0.4 / N) * 0.62);
  for (let i = 0; i < N; i++) {
    const l = h("div", "rl", String(nums[i]));
    l.style.transform = "translate(-50%,-50%) rotate(" + (i + 0.5) * SEG + "deg) translateY(calc(var(--rs) * -" + (radial ? 0.4 : 0.37) + "))" + (radial ? " rotate(-90deg)" : "");
    l.style.fontSize = "calc(var(--rs) * " + (radial ? k : 0.085) + ")";
    wheel.append(l);
  }
  wrap.append(wheel, h("div", "rptr"));
  const res = h("div", "big"), go = botao("GIRAR");
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const w = await api("/api/admin/campanhas/" + c.id + "/sortear", "POST"), i = nums.indexOf(w.n);
      const centro = (i + 0.5) * SEG, jit = (Math.random() - 0.5) * SEG * 0.7;
      const rot = (5 + Math.floor(Math.random() * 4)) * 360 + (((-(centro + jit)) % 360) + 360) % 360;
      wheel.style.transition = "transform 5s cubic-bezier(0.15, 0.7, 0.1, 1)"; wheel.style.transform = "rotate(" + rot + "deg)";
      setTimeout(async () => { res.textContent = "Nº " + w.n + " · " + w.nome; await carregar(); }, 5100);
    } catch (e) { res.textContent = e.message; }
  });
  openModal(false, h("h3", null, "Roleta: " + c.premio), wrap, res, go);
}

/* ---------- Prova do sorteio (qualquer pessoa confere no próprio navegador) ---------- */
const hex = b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
const sha256 = async t => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
async function hmac(chave, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
async function prova(c) {
  try {
    const v = await api("/api/campanhas/" + c.id + "/verificacao"), res = h("div");
    const linha = (t, val) => [h("h4", null, t), h("p", "mono", String(val))];
    const conferir = botao("Conferir no meu navegador", "", async () => {
      const snap = await sha256(v.numeros.join(",")), n = v.numeros[Number(BigInt("0x" + await hmac(v.seed, snap)) % BigInt(v.numeros.length))];
      const okSeed = (await sha256(v.seed)) === v.commit_hash, okVenc = n === v.vencedor && snap === v.snapshot_hash;
      res.textContent = (okSeed ? "✔ A semente bate com o compromisso publicado. " : "✘ Semente diferente do compromisso! ") + (okVenc ? "✔ O vencedor recalculado é o Nº " + n + "." : "✘ O vencedor não confere!");
      res.className = okSeed && okVenc ? "ok" : "ruim";
    });
    openModal(true, h("h3", null, "Prova: " + c.premio),
      h("p", "muted", "O compromisso (hash da semente) é publicado quando o sorteio é criado. Depois do sorteio, a semente é revelada e qualquer pessoa refaz a conta: vencedor = números[HMAC-SHA256(semente, sha256(números)) mod N]."),
      ...linha("Compromisso (publicado antes)", v.commit_hash), ...linha("Semente (revelada depois)", v.seed), ...linha("Números que participaram", v.numeros.join(", ")),
      ...linha("Hash dos números", v.snapshot_hash), ...linha("Número vencedor", v.vencedor), conferir, res);
  } catch (e) { aviso("Ops", e.message); }
}

/* ---------- Minha conta ---------- */
async function conta() {
  const p = await api("/api/conta"), nome = campo("Nome", "text", p.nome), tel = campo("Telefone", "tel", p.telefone || ""), err = h("p", "err");
  const atual = campo("Senha atual", "password"), nova = campo("Nova senha", "password"), err2 = h("p", "err"), del = campo("Senha para confirmar a exclusão", "password"), err3 = h("p", "err");
  const notas = h("div"); const ns = await api("/api/notificacoes");
  if (!ns.length) notas.append(h("p", "muted", "Nenhuma notificação."));
  ns.forEach(n => { const d = h("p", null); d.append(h("b", null, (n.lida ? "" : "● ") + n.titulo + " "), h("span", "muted", dataHora(n.criado_em) + " — " + n.texto)); notas.append(d); });
  if (S.naoLidas) { api("/api/notificacoes/lidas", "POST").then(() => { S.naoLidas = 0; render(); }); }
  openModal(true, h("h3", null, "Minha conta"), h("p", "muted", p.email + (p.email_verificado ? " · e-mail confirmado" : " · e-mail NÃO confirmado")),
    h("h4", null, "Dados"), nome.w, tel.w, err, botao("Salvar dados", "", () => rodar(err, async () => { await api("/api/conta", "PUT", { nome: nome.i.value, telefone: tel.i.value }); await carregar(); err.textContent = "Salvo!"; })),
    h("h4", null, "Alterar senha"), atual.w, nova.w, err2, botao("Alterar senha", "", () => rodar(err2, async () => { await api("/api/conta/senha", "POST", { atual: atual.i.value, nova: nova.i.value }); atual.i.value = nova.i.value = ""; err2.textContent = "Senha alterada! Outros dispositivos foram desconectados."; })),
    h("h4", null, "Notificações"), notas,
    h("h4", null, "Excluir minha conta (LGPD)"), h("p", "muted", "Remove seu nome, e-mail e telefone. Esta ação não pode ser desfeita."), del.w, err3,
    botao("Excluir minha conta", "alt", () => rodar(err3, async () => { if (!confirm("Tem certeza? Isso não pode ser desfeito.")) return; await api("/api/conta/excluir", "POST", { senha: del.i.value }); await carregar(); aviso("Conta excluída", "Seus dados pessoais foram removidos."); })));
}

/* ---------- Painel admin ---------- */
function painel(aba, editar) {
  const tabs = h("div", "tabs");
  [["painel", "Painel"], ["sorteios", "Sorteios"], ["pedidos", "Pedidos"], ["entregas", "Entregas"], ["usuarios", "Usuários"], ["logs", "Logs"], ["visual", "Aparência"]].forEach(([k, nome]) =>
    tabs.append(botao(nome, k === aba ? "on" : "", () => painel(k))));
  const corpo = h("div");
  openModal(true, h("h3", null, "Painel GOATSKINS"), tabs, corpo);
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
  S.c.filter(x => x.id !== c.id || !edit).forEach(x => box.append(h("div", "arow", x.premio + " (" + x.total + "/" + x.max + ", " + x.status + ")")));
}

async function abaPedidos(box) {
  const d = await api("/api/admin/pedidos"), err = h("p", "err"), st = h("div", "stat", "Receita confirmada"); st.prepend(h("b", null, brl(d.receita))); box.append(st, err);
  const rb = d.pedidos.filter(p => p.status === "REFUND_NEEDED");
  if (rb.length) { box.append(h("h4", null, "Reembolsos pendentes (devolva no painel do Mercado Pago e marque aqui)")); rb.forEach(p => { const row = h("div", "arow"); row.append(h("span", null, p.nome + " · " + p.email + " · " + p.premio + " · Nº " + JSON.parse(p.numeros).join(",") + " · " + brl(p.total) + " · ref. " + (p.mp_order_id || "-")),
    botao("Marcar reembolsado", "alt", () => rodar(err, async () => { await api("/api/admin/pedidos/" + p.id + "/reembolsado", "POST"); painel("pedidos"); }))); box.append(row); }); }
  box.append(h("h4", null, "Pedidos"), tabela(["Quando", "Sorteio", "Pessoa", "Números", "Total", "Status"], d.pedidos.map(p => [dataHora(p.criado_em), p.premio, p.nome, JSON.parse(p.numeros).join(","), brl(p.total), STATUS_PEDIDO[p.status] || p.status])));
}

async function abaEntregas(box) {
  const gs = await api("/api/admin/ganhadores"), err = h("p", "err"); box.append(err);
  if (!gs.length) box.append(h("p", "muted", "Nenhum sorteio realizado ainda."));
  gs.forEach(g => { const row = h("div", "arow"); row.append(h("span", null, g.premio + " · Nº " + g.n + " · " + g.nome + " · " + (g.email || "sem e-mail") + (g.telefone ? " · " + g.telefone : "") + (g.entregue_em ? " · ENTREGUE em " + dataHora(g.entregue_em) : " · a entregar")));
    if (!g.entregue_em) row.append(botao("Marcar entregue", "alt", () => rodar(err, async () => { await api("/api/admin/campanhas/" + g.id + "/entregar", "POST"); painel("entregas"); }))); box.append(row); });
}

async function abaUsuarios(box) {
  const us = await api("/api/admin/usuarios"), err = h("p", "err"); box.append(err);
  us.forEach(u => {
    const row = h("div", "arow"), bt = h("span");
    row.append(h("span", null, u.nome + " · " + (u.email || "sem e-mail") + " · " + u.role + " · " + u.status + (u.email_verificado ? "" : " · e-mail pendente")));
    if (u.role !== "SUPER_ADMIN" && u.id !== S.eu.id && u.status !== "DELETED") {
      const alvo = u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
      bt.append(botao(alvo === "SUSPENDED" ? "Suspender" : "Reativar", "alt", () => rodar(err, async () => { await api("/api/admin/usuarios/" + u.id + "/status", "PUT", { status: alvo }); painel("usuarios"); })));
      if (S.eu.role === "SUPER_ADMIN") bt.append(" ", botao(u.role === "ADMIN" ? "Tornar usuário" : "Tornar admin", "alt", () => rodar(err, async () => { await api("/api/admin/usuarios/" + u.id + "/papel", "PUT", { role: u.role === "ADMIN" ? "USER" : "ADMIN" }); painel("usuarios"); })));
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
    botao("Salvar aparência", "", () => { const file = ban.i.files[0]; file ? lerFoto(file, salvar) : salvar(undefined); }), " ", botao("Remover banner", "alt", () => salvar("")));
}

/* ---------- Menu lateral (botão de 3 barras) ---------- */
const mobileMQ = window.matchMedia("(max-width: 820px)");
function menuAberto(aberto, guardar) {
  document.body.classList.toggle("menu-closed", !aberto);
  $("menuBtn").setAttribute("aria-expanded", String(aberto));
  $("scrim").hidden = !(aberto && mobileMQ.matches);
  if (guardar && !mobileMQ.matches) { try { localStorage.setItem("menu", aberto ? "1" : "0"); } catch (e) { /* sem storage: tudo bem */ } }
}
$("menuBtn").addEventListener("click", () => menuAberto(document.body.classList.contains("menu-closed"), true));
$("scrim").addEventListener("click", () => menuAberto(false));
document.addEventListener("keydown", e => { if (e.key === "Escape" && mobileMQ.matches && !document.body.classList.contains("menu-closed")) menuAberto(false); });
mobileMQ.addEventListener("change", () => menuAberto(!mobileMQ.matches));
(() => { let pref = null; try { pref = localStorage.getItem("menu"); } catch (e) { /* ignora */ } menuAberto(mobileMQ.matches ? false : pref !== "0"); })();

/* ---------- Início ---------- */
$("closeBtn").addEventListener("click", closeModal);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("modal").hidden) closeModal(); });
$("modal").addEventListener("click", e => { if (e.target === $("modal")) closeModal(); });
document.querySelectorAll(".nv[data-view]").forEach(b => b.addEventListener("click", () => {
  if (mobileMQ.matches) menuAberto(false);
  view = b.dataset.view; if (view === "bilhetes" && !S.eu) authModal("entrar"); render(); window.scrollTo(0, 0); if (view === "bilhetes") carregarPedidos();
}));
$("loginBtn").addEventListener("click", async () => { if (S.eu) { await api("/api/logout", "POST"); await carregar(); } else authModal("entrar"); });
$("contaBtn").addEventListener("click", () => conta().catch(e => aviso("Ops", e.message)));
$("adminBtn").addEventListener("click", () => painel("painel"));
carregar().then(() => {
  const q = new URLSearchParams(location.search);
  if (q.get("msg") === "email-verificado") aviso("E-mail confirmado!", "Pronto, agora você já pode participar dos sorteios.");
  else if (q.get("msg") === "link-invalido") aviso("Link inválido", "Este link expirou ou já foi usado. Peça um novo em 'Minha conta'.");
  else {
    const tk = q.get("redefinir") || new URLSearchParams(location.hash.slice(1)).get("redefinir");
    if (tk && /^[a-f0-9]{64}$/.test(tk)) authModal("reset:" + tk);
  }
  if (q.toString() || location.hash) history.replaceState(null, "", location.pathname);
}).catch(() => aviso("Servidor fora do ar", "Não consegui falar com o servidor. Confira se ele está rodando."));
