/* GOATSKINS – servidor HTTP (Node.js puro, sem dependências).
   Rodar:  node --no-warnings server.js
   Criar o primeiro SUPER_ADMIN:  node --no-warnings server.js criar-admin email@exemplo.com SuaSenha123 "Seu Nome" */
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const cfg = require("./src/config"), { db, iniciar, fechar, agora, audit } = require("./src/db");
const { Erro, ipDe } = require("./src/http");
const auth = require("./src/auth");

async function criarAdmin() { // usa o banco do DATABASE_URL (em produção: rode no Shell do Render ou com a External URL)
  const [, , , email, senha, nome] = process.argv;
  if (!email || !senha || senha.length < 8) { console.log('Use: node --no-warnings server.js criar-admin email senha(8+ com letras e números) "Nome"'); process.exit(1); }
  await iniciar();
  const e = email.toLowerCase(), h = auth.hashSenha(senha), now = agora();
  if (await db.get("SELECT 1 FROM users WHERE email=? OR contato=?", [e, e])) await db.run("UPDATE users SET hash=?, role='SUPER_ADMIN', status='ACTIVE', email_verificado=1, atualizado_em=? WHERE email=? OR contato=?", [h, now, e, e]);
  else await db.run("INSERT INTO users(nome,contato,email,hash,role,email_verificado,criado_em,atualizado_em) VALUES(?,?,?,?,'SUPER_ADMIN',1,?,?)", [nome || "Admin", e, e, h, now, now]);
  await audit(null, "ADMIN_CRIADO_PELO_TERMINAL", e); console.log("SUPER_ADMIN pronto:", e); await fechar(); process.exit(0);
}

process.on("unhandledRejection", e => console.error("[rejeição não tratada]", e && e.message));
process.on("uncaughtException", e => { console.error("[erro fatal]", e); process.exit(1); }); // o gerenciador (pm2/systemd) reinicia

const ROTAS = [...auth.rotas, ...require("./src/rifas").rotas, ...require("./src/pedidos").rotas, ...require("./src/admin").rotas];
const PAPEIS_ADMIN = ["ADMIN", "SUPER_ADMIN"];

async function despachar(req, res, rota, body) {
  const user = await auth.usuarioDaSessao(req);
  for (const [metodo, rx, fn, guarda] of ROTAS) {
    if (metodo !== req.method) continue;
    const m = rota.match(rx); if (!m) continue;
    if (metodo !== "GET" && guarda !== "webhook" && req.headers["x-requested-with"] !== "goatskins") throw new Erro("Requisição não permitida.", 403); // proteção CSRF
    if (guarda && guarda !== "webhook") { // o webhook não tem sessão: ele se autentica pela assinatura do Mercado Pago
      if (!user) throw new Erro("Entre na sua conta.", 401);
      if ((guarda === "admin" && !PAPEIS_ADMIN.includes(user.role)) || (guarda === "super" && user.role !== "SUPER_ADMIN")) throw new Erro("Acesso negado.", 403);
    }
    return fn({ req, res, body, user, ip: ipDe(req), params: m.slice(1), query: Object.fromEntries(req.urlObj.searchParams) });
  }
  throw new Erro("Rota não encontrada.", 404);
}

const TIPOS = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png", ".ico": "image/x-icon" };
function cabecalhos(res) {
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()"); res.setHeader("Cross-Origin-Opener-Policy", "same-origin"); res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (cfg.PRODUCAO) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  cabecalhos(res);
  let url; try { url = new URL(req.url, "http://localhost"); if (url.origin !== "http://localhost") throw 0; } catch (e) { res.writeHead(400); return res.end(); } // "GET //" derrubava o servidor
  const rota = url.pathname; req.urlObj = url;
  if (rota.startsWith("/api/")) {
    const partes = []; let tam = 0, estourou = false;
    req.on("data", c => { tam += c.length; if (tam > 5e6) { estourou = true; json(res, 413, { erro: "Arquivo grande demais." }); req.destroy(); } else partes.push(c); });
    req.on("end", async () => {
      if (estourou) return;
      try {
        let body = {}; if (partes.length) { try { body = JSON.parse(Buffer.concat(partes).toString()); } catch (e) { throw new Erro("JSON inválido."); } }
        const r = await despachar(req, res, rota, body && typeof body === "object" ? body : {});
        if (r && r.raw) { res.writeHead(200, { "Content-Type": r.tipo, "Cache-Control": "public, max-age=86400" }); return res.end(r.raw); }
        if (r && r.redirect) { res.writeHead(302, { Location: r.redirect }); return res.end(); }
        json(res, 200, r);
      } catch (e) {
        if (!(e instanceof Erro)) console.error(e);
        json(res, e instanceof Erro ? e.code : 500, { erro: e instanceof Erro ? e.message : "Erro interno." });
      }
    });
    return;
  }
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  const PUB = path.join(cfg.raiz, "public");
  let f; try { f = path.join(PUB, decodeURIComponent(rota === "/" ? "/index.html" : rota)); } catch (e) { res.writeHead(400); return res.end(); }
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); } // impede ../ para ler arquivos fora de public
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Não encontrado"); }
    const ext = path.extname(f);
    res.writeHead(200, { "Content-Type": TIPOS[ext] || "application/octet-stream", "Cache-Control": ext === ".jpg" ? "public, max-age=86400" : "no-cache" }); res.end(data);
  });
});
async function main() {
  if (process.argv[2] === "criar-admin") return criarAdmin();
  await iniciar(); // cria/atualiza as tabelas no PostgreSQL antes de aceitar requisições
  server.listen(cfg.PORT, () => console.log("GOATSKINS rodando em " + cfg.APP_URL));
}
main().catch(e => { console.error("Falha ao iniciar:", e.message); process.exit(1); });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(async () => { try { await fechar(); } catch (e) { /* já fechado */ } process.exit(0); }));
