/* Sobe o servidor de verdade com um banco FALSO (tests/helpers/pg-falso.js) e confere a camada HTTP: cabeçalhos, health check, limites, CSRF, arquivos. */
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process"), net = require("node:net"), path = require("node:path"), fs = require("node:fs"), os = require("node:os");
const RAIZ = path.join(__dirname, ".."), PORT = 3600 + Math.floor(Math.random() * 300), BASE = "http://localhost:" + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "goat-smoke-"));
let srv;
const subir = (extra = {}) => new Promise(async (ok, falha) => {
  const p = spawn("node", ["--no-warnings", "-r", "./tests/helpers/pg-falso.js", "server.js"], { cwd: RAIZ, stdio: "ignore",
    env: { PATH: process.env.PATH, PORT: String(PORT), NODE_ENV: "test", TESTE: "1", DATA_DIR: DATA, APP_URL: BASE, MP_ACCESS_TOKEN: "", MP_WEBHOOK_SECRET: "", ...extra } });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/healthz"); return ok(p); } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  p.kill(); falha(new Error("servidor não subiu"));
});
test.before(async () => { srv = await subir(); });
test.after(() => { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });
const bruto = linha => new Promise(res => { const s = net.connect(PORT, "localhost", () => s.write(linha + " HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")); let d = ""; s.on("data", x => d += x); s.on("close", () => res(d)); s.on("error", () => res(d)); });
const J = { "Content-Type": "application/json", "X-Requested-With": "goatskins" };

test("health check: GET e HEAD respondem 200 com o banco no ar", async () => {
  assert.equal((await fetch(BASE + "/healthz")).status, 200); assert.equal((await fetch(BASE + "/healthz", { method: "HEAD" })).status, 200);
});
test("health check: 503 quando o banco não responde (e o servidor continua de pé)", async () => {
  const outro = spawn("node", ["--no-warnings", "-r", "./tests/helpers/pg-falso.js", "server.js"], { cwd: RAIZ, stdio: "ignore",
    env: { PATH: process.env.PATH, PORT: String(PORT + 1000), NODE_ENV: "test", TESTE: "1", DATA_DIR: DATA, APP_URL: BASE, MP_ACCESS_TOKEN: "", MP_WEBHOOK_SECRET: "", FALHAR_PING: "1" } });
  try {
    let r; for (let i = 0; i < 50 && !r; i++) { try { r = await fetch("http://localhost:" + (PORT + 1000) + "/healthz"); } catch (e) { await new Promise(x => setTimeout(x, 100)); } }
    assert.equal(r.status, 503);
  } finally { outro.kill(); }
});
test("cabeçalhos de segurança em páginas e na API", async () => {
  for (const u of ["/", "/api/estado", "/termos.html"]) {
    const r = await fetch(BASE + u), csp = r.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.equal(r.headers.get("x-frame-options"), "DENY"); assert.ok(r.headers.get("permissions-policy"));
  }
  assert.equal((await fetch(BASE + "/api/estado")).headers.get("cache-control"), "no-store");
});
test("CORS: nenhuma origem externa é autorizada", async () => {
  const r = await fetch(BASE + "/api/estado", { headers: { Origin: "https://evil.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const pre = await fetch(BASE + "/api/login", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null); assert.notEqual(pre.status, 200);
});
test("CSRF: POST/PUT/DELETE sem o cabeçalho X-Requested-With são barrados (exceto o webhook, que usa assinatura)", async () => {
  for (const [m, u] of [["POST", "/api/login"], ["POST", "/api/registro"], ["PUT", "/api/conta"], ["DELETE", "/api/admin/campanhas/1"], ["POST", "/api/campanhas/1/pedidos"]])
    assert.equal((await fetch(BASE + u, { method: m, headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403, m + " " + u);
  assert.equal((await fetch(BASE + "/api/webhooks/mercadopago", { method: "POST", body: "{}" })).status, 503); // sem MP configurado: indisponível, mas não 403
});
test("webhook sem segredo configurado não confirma nada", async () => {
  const r = await fetch(BASE + "/api/webhooks/mercadopago?data.id=ORD123456789012&type=order", { method: "POST", headers: { "x-signature": "ts=1,v1=abc", "x-request-id": "r" }, body: "{}" });
  assert.equal(r.status, 503);
});
test("corpo grande demais: 413 fora do painel (100 KB) e o servidor continua vivo", async () => {
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: J, body: JSON.stringify({ email: "a@a.com", senha: "x".repeat(300000) }) });
  assert.equal(r.status, 413); assert.equal((await fetch(BASE + "/healthz")).status, 200);
});
test("JSON inválido = 400 sem detalhes internos; rota inexistente = 404; erro 5xx nunca mostra stack", async () => {
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: J, body: "{quebrado" }); assert.equal(r.status, 400);
  const t = await r.text(); assert.ok(!/at .*\.js|node_modules|SyntaxError/.test(t));
  assert.equal((await fetch(BASE + "/api/nao-existe")).status, 404);
});
test("URL malformada não derruba o servidor", async () => {
  for (const u of ["GET //", "GET ///x", "GET http://", "GET /%E0%A4%A"]) assert.match(await bruto(u), /^HTTP\/1\.1 (400|404)/);
  assert.equal((await fetch(BASE + "/healthz")).status, 200);
});
test("path traversal, arquivos ocultos e de código-fonte não são servidos", async () => {
  fs.writeFileSync(path.join(RAIZ, "public", ".oculto-teste"), "segredo");
  try {
    for (const u of ["/../.env", "/..%2f.env", "/%2e%2e/server.js", "/..%2fsrc%2fdb.js", "/.oculto-teste", "/.env", "/package.json", "/src/config.js", "/data/emails.log", "/%2e%2e%2f%2e%2e%2fetc/passwd"]) {
      const r = await fetch(BASE + u); assert.ok([400, 403, 404].includes(r.status), u + " -> " + r.status);
      assert.ok(!(await r.text()).includes("segredo"), u);
    }
  } finally { fs.unlinkSync(path.join(RAIZ, "public", ".oculto-teste")); }
});
test("métodos inesperados em arquivos estáticos: 405", async () => {
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await fetch(BASE + "/", { method: m })).status, 405);
});
test("rotas protegidas respondem 401 sem sessão (nada vaza)", async () => {
  for (const [m, u] of [["GET", "/api/conta"], ["GET", "/api/pedidos"], ["GET", "/api/admin/dashboard"], ["GET", "/api/admin/pedidos"], ["GET", "/api/admin/usuarios"], ["GET", "/api/admin/logs"], ["GET", "/api/notificacoes"]])
    assert.equal((await fetch(BASE + u, { method: m, headers: J })).status, 401, u);
  for (const [m, u] of [["POST", "/api/admin/campanhas"], ["POST", "/api/campanhas/1/pedidos"], ["POST", "/api/admin/pedidos/" + "a".repeat(32) + "/reembolsado"], ["PUT", "/api/admin/usuarios/1/papel"]])
    assert.equal((await fetch(BASE + u, { method: m, headers: J, body: "{}" })).status, 401, u);
});
