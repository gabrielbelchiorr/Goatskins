/* Testes automáticos (sem bibliotecas):  npm test   ou   node --no-warnings --test tests/ */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "goat-")), PORT = 3300 + Math.floor(Math.random() * 500), BASE = "http://localhost:" + PORT;
const MP_PORT = 4300 + Math.floor(Math.random() * 400), SEGREDO = "segredo-de-teste", TOKEN = "TOKEN-DE-TESTE-NAO-VAZAR";
const env = { ...process.env, DATA_DIR: DIR, PORT: String(PORT), TESTE: "1", EMAIL_DRIVER: "console", APP_URL: BASE, NODE_ENV: "test",
  MP_ACCESS_TOKEN: TOKEN, MP_WEBHOOK_SECRET: SEGREDO, MP_API_BASE: "http://localhost:" + MP_PORT, RESERVA_SEGUNDOS: "3" };
let srv;
/* Mercado Pago FALSO (só para teste): imita POST /v1/orders e GET /v1/orders/:id da Orders API */
const http = require("node:http"), mpOrders = new Map(), mpChaves = new Map(); let mpSeq = 0, mpAuthErrada = 0;
const mpServer = http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const rs = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== "Bearer " + TOKEN) { mpAuthErrada++; return rs(401, { message: "unauthorized" }); }
    if (req.method === "POST" && req.url === "/v1/orders") {
      const k = req.headers["x-idempotency-key"]; if (!k) return rs(400, { errors: [{ code: "idempotency_key_required" }] });
      if (mpChaves.has(k)) return rs(201, mpOrders.get(mpChaves.get(k)));
      const d = JSON.parse(b), id = "ORD" + String(++mpSeq).padStart(12, "0") + "TEST", pg = d.transactions.payments[0];
      const o = { id, type: "online", total_amount: d.total_amount, external_reference: d.external_reference, status: "action_required", status_detail: "waiting_transfer",
        transactions: { payments: [{ id: "PAY" + mpSeq, status: "action_required", status_detail: "waiting_transfer", amount: pg.amount,
          payment_method: { id: "pix", type: "bank_transfer", ticket_url: "https://www.mercadopago.com.br/sandbox/payments/1/ticket?hash=abc", qr_code: "00020126580014br.gov.bcb.pix0136teste", qr_code_base64: "iVBORw0KGgo=" } }] }, _recebido: d };
      mpOrders.set(id, o); mpChaves.set(k, id); return rs(201, o);
    }
    const m = req.url.match(/^\/v1\/orders\/(ORD\w+)$/); if (req.method === "GET" && m && mpOrders.has(m[1])) return rs(200, mpOrders.get(m[1]));
    rs(404, { message: "not found" });
  });
});
const mpEstado = (id, status, extra = {}) => { const o = mpOrders.get(id), pg = o.transactions.payments[0];
  if (status === "pago") Object.assign(o, { status: "processed", status_detail: "accredited", total_paid_amount: o.total_amount }, extra), Object.assign(pg, { status: "processed", status_detail: "accredited", paid_amount: o.total_amount });
  else Object.assign(o, { status, ...extra }); };

/* "Navegador" de teste: guarda o cookie de sessão de cada pessoa */
function cliente() {
  let sid = "";
  const chamar = async (metodo, url, body, extra = {}) => {
    const r = await fetch(BASE + url, { method: metodo, redirect: "manual",
      headers: { "Content-Type": "application/json", "X-Requested-With": "goatskins", ...(sid ? { Cookie: "sid=" + sid } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get("set-cookie"); if (c) { const m = c.match(/sid=([^;]*)/); sid = m[1]; }
    const dados = await r.json().catch(() => ({}));
    return { status: r.status, dados, loc: r.headers.get("location") };
  };
  return { get: u => chamar("GET", u), post: (u, b) => chamar("POST", u, b || {}), put: (u, b) => chamar("PUT", u, b || {}), del: u => chamar("DELETE", u), chamar };
}
const emailsDe = para => fs.readFileSync(path.join(DIR, "emails.log"), "utf8").split("=== ").filter(b => b.startsWith("para: " + para));
const tokenDe = (para, padrao) => { const m = emailsDe(para).pop().match(padrao); return m[1]; };
let seq = 0;
async function novoUsuario(verificar = true) {
  const c = cliente(), email = "u" + (++seq) + "@teste.com";
  const r = await c.post("/api/registro", { nome: "Pessoa Teste " + seq, email, senha: "Senha1234", maior18: true, consentimento: true });
  assert.equal(r.status, 200);
  if (verificar) { const v = await c.get("/api/verificar-email?token=" + tokenDe(email, /token=([a-f0-9]+)/)); assert.equal(v.status, 302); }
  return { c, email };
}
async function adminLogado() { const c = cliente(); assert.equal((await c.post("/api/login", { email: "admin@teste.com", senha: "Admin1234" })).status, 200); return c; }
async function novoSorteio(adm, over = {}) {
  const r = await adm.post("/api/admin/campanhas", { premio: "Skin Teste", desgaste: "FT", valor: 100, fim: "2026-12-31", max: 5, max_por_usuario: 1, ...over });
  assert.equal(r.status, 200); const e = await adm.get("/api/estado"); return e.dados.c[e.dados.c.length - 1];
}

before(() => new Promise(r => mpServer.listen(MP_PORT, r)));
before(async () => {
  const r = spawnSync("node", ["--no-warnings", "server.js", "criar-admin", "admin@teste.com", "Admin1234", "Chefe"], { env, encoding: "utf8" });
  assert.match(r.stdout, /SUPER_ADMIN pronto/);
  srv = spawn("node", ["--no-warnings", "server.js"], { env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/api/estado"); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error("servidor não subiu");
});
after(() => { srv.kill(); mpServer.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

test("cadastro valida senha fraca, falta de consentimento e e-mail repetido", async () => {
  const c = cliente(), base = { nome: "Ana Teste", email: "ana@teste.com", senha: "Senha1234", maior18: true, consentimento: true };
  assert.equal((await c.post("/api/registro", { ...base, senha: "abc" })).status, 400);
  assert.equal((await c.post("/api/registro", { ...base, consentimento: false })).status, 400);
  assert.equal((await c.post("/api/registro", base)).status, 200);
  assert.equal((await cliente().post("/api/registro", base)).status, 400);
});

test("senha não fica em texto puro e o e-mail de verificação é gerado", async () => {
  const { email } = await novoUsuario(false);
  assert.match(emailsDe(email).pop(), /verificar-email\?token=/);
  const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(path.join(DIR, "goatskins.db"));
  const h = d.prepare("SELECT hash FROM users WHERE email=?").get(email).hash; d.close();
  assert.ok(h.includes(":") && !h.includes("Senha1234"));
});

test("sem e-mail verificado não é possível escolher números", async () => {
  const adm = await adminLogado(), s = await novoSorteio(adm), { c } = await novoUsuario(false);
  assert.equal((await c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [1] })).status, 403);
});

test("login: erro genérico e bloqueio da conta após 5 falhas", async () => {
  const { email } = await novoUsuario(), c = cliente();
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/login", { email, senha: "errada123" })).status, 401);
  assert.equal((await c.post("/api/login", { email, senha: "Senha1234" })).status, 429); // mesmo com a senha certa
  assert.equal((await c.post("/api/login", { email: "naoexiste@x.com", senha: "qualquer123" })).status, 401);
});

test("permissões: usuário comum não acessa admin, não vira admin e CSRF é barrado", async () => {
  const { c } = await novoUsuario();
  assert.equal((await c.get("/api/admin/dashboard")).status, 403);
  assert.equal((await cliente().get("/api/admin/dashboard")).status, 401);
  await c.put("/api/conta", { nome: "Hacker Teste", role: "SUPER_ADMIN", email_verificado: 1 });
  assert.equal((await c.get("/api/conta")).dados.role, "USER");
  assert.equal((await c.put("/api/admin/usuarios/1/papel", { role: "ADMIN" })).status, 403);
  assert.equal((await cliente().chamar("POST", "/api/login", { email: "a@a.com", senha: "x" }, { "X-Requested-With": "" })).status, 403);
});

test("concorrência: 12 pessoas disputam o mesmo número e só uma consegue", async () => {
  const adm = await adminLogado(), s = await novoSorteio(adm, { max: 10 });
  const pessoas = await Promise.all(Array.from({ length: 12 }, () => novoUsuario()));
  const rs = await Promise.all(pessoas.map(p => p.c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [7] })));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(rs.filter(r => r.status === 400).length, 11);
  assert.deepEqual((await adm.get("/api/estado")).dados.c.find(x => x.id === s.id).ocupados, [7]);
});

test("limite de números por pessoa e número fora do sorteio", async () => {
  const adm = await adminLogado(), s = await novoSorteio(adm, { max: 10, max_por_usuario: 2 }), { c } = await novoUsuario();
  assert.equal((await c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [1, 2, 3] })).status, 400);
  assert.equal((await c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [11] })).status, 400);
  assert.equal((await c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [1, 2] })).status, 200);
  assert.equal((await c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [3] })).status, 400);
});

test("sorteio verificável: só com vagas cheias, semente oculta antes e conferível depois", async () => {
  const adm = await adminLogado(), s = await novoSorteio(adm, { max: 3 }), pessoas = await Promise.all([1, 2, 3].map(() => novoUsuario()));
  assert.ok(!JSON.stringify((await adm.get("/api/estado")).dados).includes("\"seed\""));          // semente nunca vaza
  await pessoas[0].c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [2] });
  assert.equal((await adm.post("/api/admin/campanhas/" + s.id + "/sortear")).status, 400);           // ainda há vagas
  await pessoas[1].c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [1] });
  await pessoas[2].c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [3] });
  assert.equal((await pessoas[0].c.post("/api/admin/campanhas/" + s.id + "/sortear")).status, 403); // comum não sorteia
  const r = await adm.post("/api/admin/campanhas/" + s.id + "/sortear"); assert.equal(r.status, 200);
  assert.equal((await adm.post("/api/admin/campanhas/" + s.id + "/sortear")).status, 400);           // não repete
  const v = (await cliente().get("/api/campanhas/" + s.id + "/verificacao")).dados;
  assert.equal(crypto.createHash("sha256").update(v.seed).digest("hex"), v.commit_hash);              // semente bate com o compromisso
  const snap = crypto.createHash("sha256").update(v.numeros.join(",")).digest("hex");
  const h = crypto.createHmac("sha256", v.seed).update(snap).digest("hex");
  assert.equal(v.numeros[Number(BigInt("0x" + h) % BigInt(v.numeros.length))], v.vencedor);           // qualquer um refaz a conta
  assert.equal(v.vencedor, r.dados.n);
});

test("recuperação de senha: link funciona uma vez e derruba sessões antigas", async () => {
  const { c, email } = await novoUsuario();
  assert.equal((await cliente().post("/api/esqueci-senha", { email })).status, 200);
  assert.equal((await cliente().post("/api/esqueci-senha", { email: "ninguem@x.com" })).status, 200);
  const token = tokenDe(email, /redefinir=([a-f0-9]+)/);
  assert.equal((await cliente().post("/api/redefinir-senha", { token, senha: "fraca" })).status, 400);
  assert.equal((await cliente().post("/api/redefinir-senha", { token, senha: "NovaSenha99" })).status, 200);
  assert.equal((await cliente().post("/api/redefinir-senha", { token, senha: "OutraSenha99" })).status, 400);
  assert.equal((await c.get("/api/conta")).status, 401);
  assert.equal((await cliente().post("/api/login", { email, senha: "NovaSenha99" })).status, 200);
});

test("exclusão de conta anonimiza os dados (LGPD)", async () => {
  const { c, email } = await novoUsuario();
  assert.equal((await c.post("/api/conta/excluir", { senha: "errada123" })).status, 401);
  assert.equal((await c.post("/api/conta/excluir", { senha: "Senha1234" })).status, 200);
  assert.equal((await cliente().post("/api/login", { email, senha: "Senha1234" })).status, 401);
});

test("admin: painel, logs de auditoria e proteção de contas de administração", async () => {
  const adm = await adminLogado(), d = (await adm.get("/api/admin/dashboard")).dados;
  assert.ok(d.usuarios > 0 && Array.isArray(d.porSorteio));
  assert.ok((await adm.get("/api/admin/logs")).dados.some(l => l.acao === "SORTEIO"));
  assert.equal((await adm.put("/api/admin/usuarios/1/status", { status: "SUSPENDED" })).status, 403); // não suspende SUPER_ADMIN
});

/* ===== Regressões da auditoria ===== */
const net = require("node:net");
const bruto = linha => new Promise(res => { const s = net.connect(PORT, "localhost", () => s.write(linha + " HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")); let d = ""; s.on("data", x => d += x); s.on("close", () => res(d)); s.on("error", () => res(d)); });

test("URL malformada não derruba o servidor (antes: GET // causava crash)", async () => {
  for (const u of ["GET //", "GET ///x", "GET http://", "GET /%E0%A4%A"]) assert.match(await bruto(u), /^HTTP\/1\.1 (400|404)/);
  assert.equal((await cliente().get("/api/estado")).status, 200); // continua vivo
});

test("não é possível excluir sorteio que já tem participantes", async () => {
  const adm = await adminLogado(), s = await novoSorteio(adm), { c } = await novoUsuario();
  assert.equal((await c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [1] })).status, 200);
  assert.equal((await adm.del("/api/admin/campanhas/" + s.id)).status, 400);
  assert.equal((await c.del("/api/admin/campanhas/" + s.id)).status, 403);
});

test("usuário comum não cria, edita nem sorteia; ID inexistente dá 404", async () => {
  const { c } = await novoUsuario(), adm = await adminLogado();
  assert.equal((await c.post("/api/admin/campanhas", { premio: "x", max: 5 })).status, 403);
  assert.equal((await c.put("/api/admin/campanhas/1", { premio: "x", max: 5 })).status, 403);
  assert.equal((await c.get("/api/admin/campanhas/1/participantes")).status, 403);
  assert.equal((await c.get("/api/admin/usuarios")).status, 403);
  assert.equal((await adm.post("/api/admin/campanhas/999999/sortear")).status, 404);
  assert.equal((await c.post("/api/campanhas/999999/numeros", { numeros: [1] })).status, 404);
});

test("entradas maliciosas são rejeitadas (tipos, limites, números inválidos)", async () => {
  const adm = await adminLogado(), s = await novoSorteio(adm, { max: 10 }), { c } = await novoUsuario();
  for (const numeros of [[0], [-1], [1.5], ["a"], [null], [{}], "7", [], Array(101).fill(1)])
    assert.equal((await c.post("/api/campanhas/" + s.id + "/numeros", { numeros })).status, 400, JSON.stringify(numeros).slice(0, 30));
  assert.equal((await adm.post("/api/admin/campanhas", { premio: "x", max: 101 })).status, 400);
  assert.equal((await adm.post("/api/admin/campanhas", { premio: "x", max: 5, valor: -5 })).status, 400);
  assert.equal((await adm.post("/api/admin/campanhas", { premio: "x", max: 5, foto: "data:image/jpeg;base64,<script>" })).status, 400);
});

test("fotos saem por URL em cache e não dentro do /api/estado", async () => {
  const adm = await adminLogado(), px = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
  assert.equal((await adm.post("/api/admin/campanhas", { premio: "Com foto", max: 5, foto: "data:image/jpeg;base64," + px })).status, 200);
  const e = (await adm.get("/api/estado")).dados, c = e.c.find(x => x.premio === "Com foto");
  assert.match(c.foto, /^\/api\/campanhas\/\d+\/foto\?v=\d+$/); assert.ok(!JSON.stringify(e).includes("base64"));
  const r = await fetch(BASE + c.foto); assert.equal(r.headers.get("content-type"), "image/jpeg"); assert.match(r.headers.get("cache-control"), /max-age/);
});

test("cabeçalhos de segurança presentes", async () => {
  const r = await fetch(BASE + "/"), csp = r.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.ok(r.headers.get("permissions-policy"));
});

test("path traversal e arquivos sensíveis não são servidos", async () => {
  for (const u of ["/../.env", "/..%2f.env", "/%2e%2e/server.js", "/..%2fsrc%2fdb.js", "/data/goatskins.db", "/.env", "/package.json"]) {
    const r = await fetch(BASE + u); assert.ok([400, 403, 404].includes(r.status), u + " -> " + r.status);
  }
});

test("produção recusa subir com configuração insegura", () => {
  const r = spawnSync("node", ["--no-warnings", "-e", "require('./src/config')"], { env: { ...process.env, NODE_ENV: "production", APP_URL: "http://x.com", EMAIL_DRIVER: "console", TESTE: "" }, encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /https/); assert.match(r.stderr, /EMAIL_DRIVER/);
});


/* ===== Pagamentos (Mercado Pago / Pix) ===== */
const assinar = (dataId, reqId = "req-" + Math.random(), segredo = SEGREDO) => {
  const ts = String(Date.now()), m = "id:" + dataId.toLowerCase() + ";request-id:" + reqId + ";ts:" + ts + ";";
  return { "x-signature": "ts=" + ts + ",v1=" + crypto.createHmac("sha256", segredo).update(m).digest("hex"), "x-request-id": reqId, "Content-Type": "application/json" };
};
const webhook = (dataId, headers, qs) => fetch(BASE + "/api/webhooks/mercadopago?" + (qs || "data.id=" + dataId + "&type=order"), { method: "POST", headers: headers || assinar(dataId), body: JSON.stringify({ action: "order.processed", data: { id: dataId } }) });
const pagoSorteio = (adm, over = {}) => novoSorteio(adm, { max: 10, max_por_usuario: 3, preco_numero: 10, ...over });
const pedir = async (c, s, numeros, extra = {}) => c.post("/api/campanhas/" + s.id + "/pedidos", { numeros, ...extra });
const mpIdDe = pedido => { for (const [id, o] of mpOrders) if (o._recebido && o.external_reference) { const p = pedido; if (o.external_reference.length === 32 && p) return id; } };
const ultimoMp = () => [...mpOrders.keys()].pop();
const estadoDe = async (c, s) => (await c.get("/api/estado")).dados.c.find(x => x.id === s.id);
const dbLer = (sql, ...a) => { const { DatabaseSync } = require("node:sqlite"), d = new DatabaseSync(path.join(DIR, "goatskins.db")); try { return d.prepare(sql).all(...a); } finally { d.close(); } };

test("pagamento: preço vem do banco; campos forjados (total, status, preço) são ignorados", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), { c } = await novoUsuario();
  assert.equal(s.preco, 10);
  const r = await pedir(c, s, [1, 2], { total: 0.01, preco: 0.01, total_centavos: 1, status: "PAID", paid: true, valor: 1, user_id: 1 });
  assert.equal(r.status, 200); assert.equal(r.dados.total, 20); assert.equal(r.dados.status, "PENDING");
  assert.equal(mpOrders.get(ultimoMp())._recebido.total_amount, "20.00");            // o Mercado Pago recebeu o valor do BANCO
  assert.ok(r.dados.pix.qr_code && r.dados.pix.qr_code_base64);
  assert.ok(!JSON.stringify(r.dados).includes("ORD0") && !JSON.stringify(r.dados).includes(TOKEN)); // ids internos e token não vazam
  const e = await estadoDe(c, s); assert.deepEqual(e.reservados, [1, 2]); assert.deepEqual(e.meus, []); assert.equal(e.total, 0); // reservado ≠ vendido
  assert.ok(!JSON.stringify((await c.get("/api/estado")).dados).includes(TOKEN));
  assert.equal((await c.post("/api/campanhas/" + s.id + "/numeros", { numeros: [5] })).status, 402);  // rota gratuita não vende sorteio pago
  assert.equal(mpAuthErrada, 0);
});

test("pagamento: sorteio gratuito não usa Pix e número inválido é recusado", async () => {
  const adm = await adminLogado(), gratis = await novoSorteio(adm, { max: 5 }), s = await pagoSorteio(adm), { c } = await novoUsuario();
  assert.equal((await pedir(c, gratis, [1])).status, 400);
  for (const n of [[0], [11], ["x"], [], [1.5]]) assert.equal((await pedir(c, s, n)).status, 400);
  assert.equal((await adm.post("/api/admin/campanhas", { premio: "x", max: 5, preco_numero: 0.5 })).status, 400);   // abaixo de R$ 1,00
  assert.equal((await adm.post("/api/admin/campanhas", { premio: "x", max: 5, preco_numero: -3 })).status, 400);
  assert.equal((await cliente().post("/api/campanhas/" + s.id + "/pedidos", { numeros: [1] })).status, 401);
});

test("webhook: sem assinatura, assinatura errada ou id adulterado são rejeitados", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), { c } = await novoUsuario();
  await pedir(c, s, [3]); const id = ultimoMp();
  assert.equal((await webhook(id, {})).status, 401);
  assert.equal((await webhook(id, assinar(id, "r1", "segredo-errado"))).status, 401);
  assert.equal((await webhook(id, assinar("ORD999999999999OUTRO"))).status, 401);          // assinou outro id
  assert.equal((await webhook(id, { ...assinar(id), "x-signature": "ts=1,v1=abc" })).status, 401);
  assert.equal((await webhook(id, assinar(id), "type=order")).status, 401);               // sem data.id
  mpEstado(id, "pago");
  assert.equal((await webhook(id, {})).status, 401);                                       // mesmo com o pagamento real, sem assinatura não conta
  assert.deepEqual((await estadoDe(c, s)).meus, []);
});

test("webhook válido mas pagamento ainda pendente NÃO marca como pago", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), { c } = await novoUsuario();
  const p = (await pedir(c, s, [4])).dados, id = ultimoMp();
  assert.equal((await webhook(id)).status, 200);
  assert.equal((await c.get("/api/pedidos/" + p.id)).dados.status, "PENDING"); assert.deepEqual((await estadoDe(c, s)).meus, []);
});

test("pagamento confirmado: números viram vendidos; webhook repetido é idempotente", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), { c } = await novoUsuario();
  const p = (await pedir(c, s, [6, 7])).dados, id = ultimoMp(); mpEstado(id, "pago");
  const antes = dbLer("SELECT COUNT(*) n FROM notifications WHERE titulo='Pagamento confirmado!'")[0].n;
  const rs = await Promise.all(Array.from({ length: 6 }, () => webhook(id)));   // 6 entregas ao mesmo tempo (o MP reenvia)
  assert.ok(rs.every(r => r.status === 200));
  assert.equal((await c.get("/api/pedidos/" + p.id)).dados.status, "PAID");
  const e = await estadoDe(c, s); assert.deepEqual(e.meus, [6, 7]); assert.deepEqual(e.reservados, []); assert.equal(e.total, 2);
  assert.equal(dbLer("SELECT COUNT(*) n FROM tickets WHERE campaign_id=?", s.id)[0].n, 2);
  assert.equal(dbLer("SELECT COUNT(*) n FROM notifications WHERE titulo='Pagamento confirmado!'")[0].n, antes + 1);
  assert.equal((await webhook(id)).status, 200); assert.equal((await c.get("/api/pedidos/" + p.id)).dados.status, "PAID");
  assert.ok((await pedir(c, s, [6])).status >= 400);                          // já vendido
});

test("pagamento com valor diferente do pedido NÃO é aceito", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), { c } = await novoUsuario();
  const p = (await pedir(c, s, [8])).dados, id = ultimoMp(); mpEstado(id, "pago", { total_paid_amount: "1.00" });
  assert.equal((await webhook(id)).status, 200); assert.equal((await c.get("/api/pedidos/" + p.id)).dados.status, "PENDING");
  mpOrders.get(id).total_paid_amount = "10.00"; mpOrders.get(id).total_amount = "1.00";   // total adulterado
  await webhook(id); assert.equal((await c.get("/api/pedidos/" + p.id)).dados.status, "PENDING");
  mpOrders.get(id).total_amount = "10.00"; mpOrders.get(id).external_reference = "ffffffffffffffffffffffffffffffff"; // referência de outro pedido
  await webhook(id); assert.equal((await c.get("/api/pedidos/" + p.id)).dados.status, "PENDING");
});

test("pagamento cancelado/recusado libera os números e não vira pago", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), a = await novoUsuario(), b = await novoUsuario();
  const p = (await pedir(a.c, s, [9])).dados, id = ultimoMp(); assert.ok((await pedir(b.c, s, [9])).status >= 400);
  mpEstado(id, "canceled"); await webhook(id);
  assert.equal((await a.c.get("/api/pedidos/" + p.id)).dados.status, "CANCELED");
  assert.equal((await pedir(b.c, s, [9])).status, 200);                               // liberado para outra pessoa
  const q = (await pedir(a.c, s, [1])).dados, id2 = ultimoMp(); mpEstado(id2, "failed"); await webhook(id2);
  assert.equal((await a.c.get("/api/pedidos/" + q.id)).dados.status, "FAILED");
});

test("reserva expirada: libera o número; pagamento tardio só vale se o número continua livre", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), a = await novoUsuario(), b = await novoUsuario(), cc = await novoUsuario();
  const pa = (await pedir(a.c, s, [1])).dados, ida = ultimoMp(), pc = (await pedir(cc.c, s, [2])).dados, idc = ultimoMp();
  await new Promise(r => setTimeout(r, 3300));                                         // reserva (3s) vence
  assert.deepEqual((await estadoDe(b.c, s)).reservados, []);
  assert.equal((await a.c.get("/api/pedidos/" + pa.id)).dados.status, "EXPIRED");
  const pb = (await pedir(b.c, s, [1])).dados;                                         // outra pessoa reserva o número 1
  mpEstado(ida, "pago"); assert.equal((await webhook(ida)).status, 200);               // A paga atrasado
  assert.equal((await a.c.get("/api/pedidos/" + pa.id)).dados.status, "REFUND_NEEDED"); // não vende o número 1 duas vezes
  assert.deepEqual((await estadoDe(a.c, s)).meus, []);
  assert.deepEqual((await estadoDe(b.c, s)).reservados, [1]);
  mpEstado(idc, "pago"); await webhook(idc);                                           // C paga atrasado, mas o 2 continua livre
  assert.equal((await cc.c.get("/api/pedidos/" + pc.id)).dados.status, "PAID"); assert.deepEqual((await estadoDe(cc.c, s)).meus, [2]);
  assert.equal(dbLer("SELECT COUNT(*) n FROM tickets WHERE campaign_id=? AND n=1", s.id)[0].n, 0);
  const ped = (await adm.get("/api/admin/pedidos")); assert.equal(ped.status, 200);
  assert.ok(ped.dados.pedidos.some(x => x.id === pa.id && x.status === "REFUND_NEEDED"));
  assert.equal((await adm.post("/api/admin/pedidos/" + pa.id + "/reembolsado")).status, 200);
  assert.equal((await adm.post("/api/admin/pedidos/" + pa.id + "/reembolsado")).status, 400);
  assert.ok(pb);
});

test("concorrência: 10 pessoas pedem o mesmo número e só um pedido é criado", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), pessoas = await Promise.all(Array.from({ length: 10 }, () => novoUsuario()));
  const rs = await Promise.all(pessoas.map(p => pedir(p.c, s, [5])));
  assert.equal(rs.filter(r => r.status === 200).length, 1); assert.equal(rs.filter(r => r.status === 400).length, 9);
  assert.equal(dbLer("SELECT COUNT(*) n FROM reservas WHERE campaign_id=? AND n=5", s.id)[0].n, 1);
  assert.equal(dbLer("SELECT COUNT(*) n FROM pedidos WHERE campaign_id=? AND status='FAILED'", s.id)[0].n, 0); // perdedores nem criam pedido
});

test("pedidos: usuário só enxerga os próprios (IDOR) e o limite de pedidos abertos vale", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm, { max_por_usuario: 10, max: 20 }), a = await novoUsuario(), b = await novoUsuario();
  const p = (await pedir(a.c, s, [1])).dados;
  assert.equal((await b.c.get("/api/pedidos/" + p.id)).status, 404); assert.equal((await b.c.post("/api/pedidos/" + p.id + "/atualizar")).status, 404);
  assert.equal((await b.c.get("/api/pedidos")).dados.length, 0); assert.equal((await cliente().get("/api/pedidos/" + p.id)).status, 401);
  assert.equal((await a.c.get("/api/pedidos/" + "0".repeat(32))).status, 404);
  assert.equal((await pedir(a.c, s, [2])).status, 200); assert.equal((await pedir(a.c, s, [3])).status, 200);
  assert.equal((await pedir(a.c, s, [4])).status, 429);                                // 3 abertos no máximo
  assert.equal((await a.c.post("/api/pedidos/" + p.id + "/atualizar")).status, 200);   // "já paguei": consulta o MP, não confia no navegador
  assert.equal((await b.c.get("/api/admin/pedidos")).status, 403); assert.equal((await b.c.post("/api/admin/pedidos/" + p.id + "/reembolsado")).status, 403);
});

test("'já paguei' só confirma se o Mercado Pago confirmar", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), { c } = await novoUsuario();
  const p = (await pedir(c, s, [2])).dados, id = ultimoMp();
  assert.equal((await c.post("/api/pedidos/" + p.id + "/atualizar", { paid: true, status: "PAID" })).dados.status, "PENDING");
  mpEstado(id, "pago"); assert.equal((await c.post("/api/pedidos/" + p.id + "/atualizar")).dados.status, "PAID");
});

test("sorteio com Pix pendente não pode ser realizado; preço não muda após vendas; entrega do prêmio", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm, { max: 2, max_por_usuario: 1 }), a = await novoUsuario(), b = await novoUsuario();
  await pedir(a.c, s, [1]); const ida = ultimoMp(); mpEstado(ida, "pago"); await webhook(ida);
  await pedir(b.c, s, [2]);                                                            // pendente
  const edit = { premio: "Skin Teste", max: 2, max_por_usuario: 1, preco_numero: 99 };
  assert.equal((await adm.put("/api/admin/campanhas/" + s.id, edit)).status, 400);     // preço travado
  assert.equal((await adm.put("/api/admin/campanhas/" + s.id, { ...edit, preco_numero: 10 })).status, 200);
  assert.equal((await adm.del("/api/admin/campanhas/" + s.id)).status, 400);
  await adm.post("/api/admin/campanhas/" + s.id + "/encerrar");
  const r = await adm.post("/api/admin/campanhas/" + s.id + "/sortear"); assert.equal(r.status, 400); assert.match(r.dados.erro, /pendentes/);
  const idb = ultimoMp(); mpEstado(idb, "pago"); await webhook(idb);
  assert.equal((await adm.post("/api/admin/campanhas/" + s.id + "/sortear")).status, 200);
  assert.equal((await a.c.get("/api/admin/ganhadores")).status, 403);
  const g = (await adm.get("/api/admin/ganhadores")).dados.find(x => x.id === s.id); assert.ok(g.email && !g.entregue_em);
  assert.equal((await a.c.post("/api/admin/campanhas/" + s.id + "/entregar")).status, 403);
  assert.equal((await adm.post("/api/admin/campanhas/" + s.id + "/entregar")).status, 200);
  assert.equal((await adm.post("/api/admin/campanhas/" + s.id + "/entregar")).status, 400);
});

test("falha do Mercado Pago ao criar o Pix libera os números e não vaza detalhes", async () => {
  const adm = await adminLogado(), s = await pagoSorteio(adm), { c } = await novoUsuario();
  mpServer.close(); await new Promise(r => setTimeout(r, 50));
  const r = await pedir(c, s, [1]); await new Promise(r => mpServer.listen(MP_PORT, r));
  assert.equal(r.status, 502); assert.ok(!JSON.stringify(r.dados).includes("localhost") && !JSON.stringify(r.dados).includes(TOKEN));
  assert.deepEqual((await estadoDe(c, s)).reservados, []);
  assert.equal((await pedir(c, s, [1])).status, 200);
});
