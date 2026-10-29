/* GOATSKINS – servidor HTTP (Node.js puro, sem dependências).
   Rodar:  node --no-warnings server.js
   Criar o primeiro SUPER_ADMIN:  node --no-warnings server.js criar-admin email@exemplo.com SuaSenha123 "Seu Nome" */
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const cfg = require("./src/config"), { db, iniciar, fechar, agora, audit, ping, tx, comAutorizacao } = require("./src/db");
const { Erro, ipDe, limite } = require("./src/http");
const auth = require("./src/auth");

async function criarAdmin() { // usa o banco do DATABASE_URL (em produção: rode no Shell do Render ou com a External URL)
  const [, , , email, senha, nome] = process.argv;
  if (!email || !senha || !auth.senhaOk(senha)) { console.log('Use: node --no-warnings server.js criar-admin email senha(8+ com letras e números) "Nome"'); process.exit(1); }
  await iniciar();
  const e = email.toLowerCase(), h = await auth.hashSenha(senha), now = agora();
  await tx(async () => {
  if (await db.get("SELECT 1 FROM users WHERE email=? OR contato=?", [e, e])) await db.run("UPDATE users SET hash=?, role='SUPER_ADMIN', status='ACTIVE', email_verificado=1, atualizado_em=? WHERE email=? OR contato=?", [h, now, e, e]);
  else await db.run("INSERT INTO users(nome,contato,email,hash,role,email_verificado,criado_em,atualizado_em) VALUES(?,?,?,?,'SUPER_ADMIN',1,?,?)", [nome || "Admin", e, e, h, now, now]);
  await db.run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=? OR contato=?)", [e,e]);
  await db.run("DELETE FROM password_recovery_jobs WHERE email IN (SELECT lower(email) FROM users WHERE email=? OR contato=?)", [e,e]);
  await db.run("DELETE FROM tokens_email WHERE tipo='REDEFINIR' AND user_id IN (SELECT id FROM users WHERE email=? OR contato=?)", [e,e]);
  await audit(null, "ADMIN_CRIADO_PELO_TERMINAL", e);
  });
  console.log("SUPER_ADMIN pronto:", e); await fechar(); process.exit(0);
}

process.on("unhandledRejection", e => console.error("[rejeição não tratada]", e && (e.code || e.name)));
process.on("uncaughtException", e => { console.error("[erro fatal]", e && (e.code || e.name)); process.exit(1); }); // o gerenciador (pm2/systemd) reinicia

const security = require("./src/security");
const ROTAS = [...security.rotas, ...auth.rotas, ...require("./src/mfa").rotas, ...require("./src/phone").rotas, ...require("./src/rifas").rotas, ...require("./src/pedidos").rotas, ...require("./src/admin").rotas];
const PAPEIS_ADMIN = ["ADMIN", "SUPER_ADMIN"];

async function despachar(req, res, rota, body) {
  let user;
  for (const [metodo, rx, fn, guarda] of ROTAS) {
    if (metodo !== req.method) continue;
    const m = rota.match(rx); if (!m) continue;
    security.csrf(req, guarda);
    await security.proteger(req, body, rota);
    if (user === undefined) user = guarda === "webhook" ? null : await auth.usuarioDaSessao(req); // o webhook não usa sessão: poupa uma consulta por notificação
    if (metodo !== "GET" && guarda !== "webhook" && req.headers["x-requested-with"] !== "goatskins") throw new Erro("Requisição não permitida.", 403); // proteção CSRF
    // Todo caminho administrativo exige papel e MFA, inclusive uma futura rota sem guarda explícita.
    const administrativa = guarda === 'admin' || guarda === 'super' || rota.startsWith('/api/admin/');
    if ((guarda && guarda !== "webhook") || administrativa) { // webhook se autentica pela assinatura do Mercado Pago
      if (!user) throw new Erro("Entre na sua conta.", 401);
      if ((administrativa && !PAPEIS_ADMIN.includes(user.role)) || (guarda === "super" && user.role !== "SUPER_ADMIN")) throw new Erro("Acesso negado.", 403);
    }
    const ctx = { req, res, body, user, ip: ipDe(req), params: m.slice(1), query: Object.fromEntries(req.urlObj.searchParams) };
    if (administrativa) await require('./src/mfa').exigir(ctx);
    if (metodo === 'POST' && /^\/api\/campanhas\/\d+\/(numeros|pedidos)$/.test(rota))
      require('./src/phone').exigir(user);
    return administrativa ? comAutorizacao(() => require('./src/mfa').exigir(ctx), () => fn(ctx)) : fn(ctx);
  }
  throw new Erro("Rota não encontrada.", 404);
}

const TIPOS = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon" };
// Apenas arquivos explicitamente usados pelo frontend podem ser servidos.
// Uma extensao permitida (como .js, .html) nao deve tornar um backup publico.
const PUBLICOS = new Set([
  'index.html','style.css','script.js','logo.jpg','logo-marca.webp','mascote.webp','cenario.webp',
  'privacidade.html','termos.html','cookies.html','page-loader.js','roulette.js','roulette.css','cookie-consent.js'
]);
function segredoOrigemValido(req) {
  if (!cfg.ORIGIN_VERIFY_SECRET) return true;
  const fornecido = req.headers['x-goatskins-origin'];
  if (typeof fornecido !== 'string') return false;
  const segredo = Buffer.from(cfg.ORIGIN_VERIFY_SECRET, 'utf8');
  const recebido = Buffer.from(fornecido, 'utf8');
  return recebido.length === segredo.length && crypto.timingSafeEqual(recebido, segredo);
}
function cabecalhos(res) {
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()"); res.setHeader("Cross-Origin-Opener-Policy", "same-origin"); res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (cfg.PRODUCAO) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  cabecalhos(res);
  req.on("error", () => { /* cliente caiu no meio do envio: nada a fazer */ });
  let url; try { url = new URL(req.url, "http://localhost"); if (url.origin !== "http://localhost") throw 0; } catch (e) { res.writeHead(400); return res.end(); } // "GET //" derrubava o servidor
  const rota = url.pathname; req.urlObj = url;
  if (rota === "/healthz" && (req.method === "GET" || req.method === "HEAD")) { // health check do Render/UptimeRobot: leve e confere o banco
    return ping().then(() => { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end(req.method === "HEAD" ? undefined : "ok"); },
      e => { console.error("[healthz] banco indisponível:", e.message); res.writeHead(503, { "Cache-Control": "no-store" }); res.end(); });
  }
  // Esta verificacao e opcional e exige um proxy que remova o header enviado
  // pelo cliente e injete seu proprio segredo. Sem esse proxy, nao habilitar no Render.
  if (!segredoOrigemValido(req)) { res.writeHead(403, { "Cache-Control": "no-store" }); return res.end(); }
  const destinoCanonico = security.redirecionamentoWww(req, url);
  if (destinoCanonico) { res.writeHead(308, { Location: destinoCanonico, 'Cache-Control': 'no-store' }); return res.end(); }
  if (rota.startsWith("/api/")) {
    try { limite("api:" + ipDe(req), 300, 60000); } catch (e) { return json(res, e.code, { erro: e.message }); }
    const partes = []; let tam = 0, estourou = false;
    const LIMITE_CORPO = rota.startsWith("/api/admin/") ? 5e6 : 1e5; // só o painel envia fotos; o resto (login, pedidos, webhook) tem poucos bytes
    req.on("data", c => { tam += c.length; if (tam > LIMITE_CORPO) { if (!estourou) { estourou = true; res.setHeader("Connection", "close"); json(res, 413, { erro: "Requisição grande demais." }); } } else if (!estourou) partes.push(c); });
    req.on("end", async () => {
      if (estourou) return;
      try {
        let body = {};
        if (partes.length) {
          try { body = JSON.parse(Buffer.concat(partes).toString()); }
          catch (e) { throw new Erro("JSON inválido."); }
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Erro("JSON deve ser um objeto.");
        }
        const r = await despachar(req, res, rota, body);
        if (r && r.raw) { res.writeHead(200, { "Content-Type": r.tipo, "Cache-Control": "public, max-age=86400" }); return res.end(r.raw); }
        if (r && r.redirect) { res.writeHead(302, { Location: r.redirect }); return res.end(); }
        json(res, 200, r);
      } catch (e) {
        if (!(e instanceof Erro)) console.error("[http] falha interna", e && (e.code || e.name));
        json(res, e instanceof Erro ? e.code : 500, { erro: e instanceof Erro ? e.message : "Erro interno.", ...(e.tipo ? { tipo: e.tipo } : {}) });
      }
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  const PUB = path.join(cfg.raiz, "public");
  let f; try { f = path.join(PUB, decodeURIComponent(rota === "/" ? "/index.html" : rota)); } catch (e) { res.writeHead(400); return res.end(); }
  if (!f.startsWith(PUB + path.sep) || path.relative(PUB, f).split(path.sep).some(p => p.startsWith("."))) { res.writeHead(403); return res.end(); } // impede ../ e arquivos ocultos (.env, .git)
  // Somente a lista explicita de recursos publicos: bloquear arquivos
  // confidenciais mesmo com extensoes como .js e .html.
  const nome = path.relative(PUB, f).replace(/\\/g, '/');
  if (!PUBLICOS.has(nome)) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end(); }
  // Um symlink com nome valido pode apontar para fora da pasta publica.
  fs.lstat(f, (err, st) => {
    if (err) { res.writeHead(404); return res.end("Não encontrado"); }
    if (st.isSymbolicLink()) { res.writeHead(403); return res.end(); }
    if (!st.isFile()) { res.writeHead(404); return res.end(); }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Não encontrado"); }
      const ext = path.extname(f).toLowerCase();
      res.writeHead(200, { "Content-Type": TIPOS[ext], "Cache-Control": ext === ".jpg" ? "public, max-age=86400" : "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  });
});
/* O balanceador do Render mantém conexões abertas por ~60 s; se o Node fechar antes (padrão 5 s) surgem 502 esporádicos. */
server.keepAliveTimeout = 65e3; server.headersTimeout = 66e3; server.requestTimeout = 120e3;
let pararRecuperacao = async () => {};
async function main() {
  if (process.argv[2] === "criar-admin") return criarAdmin();
  await iniciar(); // cria/atualiza as tabelas no PostgreSQL antes de aceitar requisições
  const registration = require("./src/registration");
  await registration.limpar();
  setInterval(() => registration.limpar().catch(() => console.error("[cadastro] falha na limpeza")), 60000).unref();
  pararRecuperacao = require("./src/recovery").iniciarProcessador();
  console.log("[e-mail] driver=" + cfg.EMAIL_DRIVER + (cfg.EMAIL_DRIVER === "console" ? " (SIMULADO; sem entrega real)" : " (Resend; confira entrega no painel)"));
  server.listen(cfg.PORT, () => console.log("GOATSKINS rodando em " + cfg.APP_URL));
}
main().catch(e => { console.error("Falha ao iniciar:", e.message); process.exit(1); });
/* Deploy/restart do Render manda SIGTERM: para de aceitar conexões novas, deixa terminar as requisições em andamento (inclusive um webhook de pagamento
   no meio de uma transação), fecha o pool e sai. O temporizador garante a saída mesmo se algum cliente segurar a conexão. */
let encerrando = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  if (encerrando) return; encerrando = true; console.log("[" + sig + "] encerrando com calma...");
  setTimeout(() => process.exit(1), 15e3).unref();
  const parado = pararRecuperacao();
  server.close(async () => { try { await parado; await fechar(); } catch (e) { /* já fechado */ } process.exit(0); });
  server.closeIdleConnections();
});
