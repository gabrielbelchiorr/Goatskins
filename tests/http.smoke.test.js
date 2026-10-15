/* Sobe o servidor de verdade com um banco FALSO (tests/helpers/pg-falso.js) e confere a camada HTTP: cabeçalhos, health check, limites, CSRF, arquivos. */
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process"), net = require("node:net"), path = require("node:path"), fs = require("node:fs"), os = require("node:os");
const RAIZ = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "goat-smoke-"));
let srv, PORT, BASE;
// O .env de desenvolvimento não pode alterar os fixtures deste teste, inclusive
// quando um dos servidores simula produção. Valores reais nunca são necessários.
const ENV_HTTP = {
  NODE_ENV: "test", RENDER: "", TESTE: "1", FALHAR_PING: "",
  DATABASE_URL: "postgresql://fixture:fixture@localhost/goatskins_test", DATABASE_SSL: "0", DATABASE_CA: "", PG_POOL_MAX: "1",
  EMAIL_DRIVER: "console", EMAIL_API_KEY: "", EMAIL_FROM: "GOATSKINS <no-reply@goatskins.test>", EMAIL_CODE_SECRET: "a".repeat(64),
  MFA_ENCRYPTION_KEY: "", TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "", TURNSTILE_HOSTNAMES: "", ORIGIN_VERIFY_SECRET: "",
  TRUST_PROXY: "0", TRUST_PROXY_HOPS: "1", MP_ACCESS_TOKEN: "", MP_WEBHOOK_SECRET: "", MP_TESTE_APRO: "",
  MP_API_BASE: "https://api.mercadopago.com", PIX_MINUTOS: "30", RESERVA_SEGUNDOS: ""
};
async function portaLivre() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(e => e ? reject(e) : resolve()));
  return port;
}
async function parar(p) {
  if (!p?.pid || p.exitCode !== null || p.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => p.kill("SIGKILL"), 2000);
    p.once("close", () => { clearTimeout(timer); resolve(); });
    p.kill();
  });
}
async function subir(extra = {}, statusEsperado = 200) {
  const port = await portaLivre(), base = "http://127.0.0.1:" + port;
  const p = spawn(process.execPath, ["--no-warnings", "-r", "./tests/helpers/pg-falso.js", "server.js"], {
    cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...ENV_HTTP, DATA_DIR: DATA, APP_URL: base, ...extra, PORT: String(port) }
  });
  let log = "", erro;
  const registrar = chunk => { log = (log + chunk.toString()).slice(-4000); };
  p.stdout.on("data", registrar); p.stderr.on("data", registrar);
  p.once("error", e => { erro = e; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !erro && p.exitCode === null && p.signalCode === null) {
    try {
      const r = await fetch(base + "/healthz", { signal: AbortSignal.timeout(500) });
      await r.arrayBuffer();
      if (r.status === statusEsperado) return { process: p, port, base };
    } catch (e) { /* aguarda o servidor de teste */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await parar(p);
  throw new Error("Servidor de teste não iniciou na porta " + port + ".\n" +
    (erro ? erro.message : log.trim() || "Tempo de inicialização esgotado, sem mensagens do processo."));
}
test.before(async () => { const iniciado = await subir(); srv = iniciado.process; PORT = iniciado.port; BASE = iniciado.base; });
test.after(async () => { await parar(srv); fs.rmSync(DATA, { recursive: true, force: true }); });
const bruto = linha => new Promise(res => { const s = net.connect(PORT, "localhost", () => s.write(linha + " HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")); let d = ""; s.on("data", x => d += x); s.on("close", () => res(d)); s.on("error", () => res(d)); });
const J = { "Content-Type": "application/json", "X-Requested-With": "goatskins" };

test("health check: GET e HEAD respondem 200 com o banco no ar", async () => {
  assert.equal((await fetch(BASE + "/healthz")).status, 200); assert.equal((await fetch(BASE + "/healthz", { method: "HEAD" })).status, 200);
});
test("health check: 503 quando o banco não responde (e o servidor continua de pé)", async () => {
  const outro = await subir({ FALHAR_PING: "1" }, 503);
  try {
    const r = await fetch(outro.base + "/healthz");
    assert.equal(r.status, 503);
  } finally { await parar(outro.process); }
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
test("JSON válido que não é um objeto é recusado antes de executar uma rota", async () => {
  for (const body of ['null', '[]', 'true', '123', '"texto"']) {
    const r = await fetch(BASE + '/api/login', {method:'POST',headers:J,body});
    assert.equal(r.status, 400);
  }
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
test("backups, configurações e código copiados para public não ficam acessíveis", async () => {
  const nomes = ['backup.dump', 'backup.sql', 'dados.json', 'copia.zip', 'senhas.txt', 'backup.js', 'rascunho.html'];
  try {
    for (const nome of nomes) fs.writeFileSync(path.join(RAIZ,'public',nome), 'SEGREDO-NAO-PUBLICAR');
    for (const nome of nomes) {
      const r = await fetch(BASE + '/' + nome);
      assert.equal(r.status, 404, nome);
      assert.ok(!(await r.text()).includes('SEGREDO-NAO-PUBLICAR'));
    }
  } finally {
    for (const nome of nomes) fs.rmSync(path.join(RAIZ,'public',nome), {force:true});
  }
  for (const nome of ['page-loader.js','roulette.js','roulette.css','cookies.html','style.css','logo-marca.webp'])
    assert.equal((await fetch(BASE + '/' + nome)).status, 200, nome);
});
test("um nome público autorizado não pode apontar para um arquivo externo", {skip:process.platform === 'win32'}, async () => {
  const filename = path.join(RAIZ, 'public', 'logo.jpg');
  const original = fs.readFileSync(filename);
  const externo = path.join(DATA, 'segredo.txt');
  fs.writeFileSync(externo, 'SEGREDO-EXTERNO');
  try {
    fs.unlinkSync(filename);
    fs.symlinkSync(externo, filename);
    const r = await fetch(BASE + '/logo.jpg');
    assert.equal(r.status, 403);
    assert.ok(!(await r.text()).includes('SEGREDO-EXTERNO'));
  } finally {
    fs.rmSync(filename, {force:true});
    fs.writeFileSync(filename, original);
  }
});
test("rotas protegidas respondem 401 sem sessão (nada vaza)", async () => {
  for (const [m, u] of [["GET", "/api/conta"], ["GET", "/api/pedidos"], ["GET", "/api/admin/dashboard"], ["GET", "/api/admin/pedidos"], ["GET", "/api/admin/usuarios"], ["GET", "/api/admin/logs"], ["GET", "/api/notificacoes"]])
    assert.equal((await fetch(BASE + u, { method: m, headers: J })).status, 401, u);
  for (const [m, u] of [["POST", "/api/admin/campanhas"], ["POST", "/api/campanhas/1/pedidos"], ["POST", "/api/admin/pedidos/" + "a".repeat(32) + "/reembolsado"], ["PUT", "/api/admin/usuarios/1/papel"]])
    assert.equal((await fetch(BASE + u, { method: m, headers: J, body: "{}" })).status, 401, u);
});
test('proteção de origem exige o segredo antes de servir página, API ou webhook, preservando health check', async () => {
  const secret='c'.repeat(64);
  const outro=await subir({ORIGIN_VERIFY_SECRET:secret}),base=outro.base;
  try {
    for(const path of ['/','/style.css','/api/estado','/api/seguranca','/api/webhooks/mercadopago']) {
      const r=await fetch(base+path,{method:path.includes('webhooks')?'POST':'GET',headers:{'cf-connecting-ip':'1.2.3.4'},body:path.includes('webhooks')?'{}':undefined});
      assert.equal(r.status,403,path);assert.ok(!(await r.text()).includes(secret));
    }
    assert.equal((await fetch(base+'/healthz')).status,200);
    assert.equal((await fetch(base+'/healthz',{method:'HEAD'})).status,200);
    assert.equal((await fetch(base+'/',{headers:{'x-goatskins-origin':secret}})).status,200);
    const config=await fetch(base+'/api/seguranca',{headers:{'x-goatskins-origin':secret}});
    assert.equal(config.status,200);assert.ok(!(await config.text()).includes(secret));
    assert.equal((await fetch(base+'/api/webhooks/mercadopago',{method:'POST',headers:{'x-goatskins-origin':secret},body:'{}'})).status,503);
  } finally {await parar(outro.process);}
});
test('produção manda documentos do alias para a origem principal e preserva parâmetros e APIs',async()=>{
  const outro=await subir({NODE_ENV:'production',TESTE:'',APP_URL:'https://goatskins.com.br',
    DATABASE_URL:'postgresql://u:p@localhost/goatskins_test',EMAIL_DRIVER:'resend',EMAIL_API_KEY:'fixture',
    EMAIL_FROM:'GOATSKINS <no-reply@goatskins.test>',EMAIL_CODE_SECRET:'a'.repeat(64),MFA_ENCRYPTION_KEY:'b'.repeat(64),
    TURNSTILE_SITE_KEY:'site-fixture',TURNSTILE_SECRET_KEY:'secret-fixture',TRUST_PROXY:'1'});
  const base=outro.base;
  try {
    // Node fetch pode ignorar 'Host' customizado; HTTP nativo testa o hostname recebido pelo servidor.
    const r=await new Promise((resolve,reject)=>{
      const req=require('node:http').get({hostname:'127.0.0.1',port:outro.port,path:'/?sorteio=7',headers:{Host:'www.goatskins.com.br'}},res=>{
        res.resume();res.on('end',()=>resolve(res));
      });req.on('error',reject);
    });
    assert.equal(r.statusCode,308);assert.equal(r.headers.location,'https://goatskins.com.br/?sorteio=7');
    const primary=await new Promise((resolve,reject)=>{
      const req=require('node:http').get({hostname:'127.0.0.1',port:outro.port,path:'/',headers:{Host:'goatskins.com.br'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject);
    });
    assert.equal(primary,200);
    const api=await fetch(base+'/api/seguranca',{redirect:'manual'});
    assert.equal(api.status,200);assert.equal(api.headers.get('location'),null);
    const post=await fetch(base+'/api/login',{method:'POST',body:'{}',redirect:'manual'});
    assert.equal(post.status,403);assert.equal(post.headers.get('location'),null);
  } finally {await parar(outro.process);}
});
