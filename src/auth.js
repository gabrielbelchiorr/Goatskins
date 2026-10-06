/* Autenticação, conta, e-mail, notificações. */
const crypto = require("node:crypto");
const cfg = require("./config"), mail = require("./mail");
const { db, sha, agora, tx, audit, notificar } = require("./db");
const { Erro, RE, txt, limite, cookie, ipDe } = require("./http");

const MAX_FALHAS = 5, BLOQUEIO_MS = 15 * 60e3, SESSAO_MS = 7 * 864e5;
const senhaOk = s => typeof s === "string" && s.length >= 8 && s.length <= 100 && /[a-zA-Z]/.test(s) && /\d/.test(s);
const SENHA_MSG = "A senha precisa ter 8 ou mais caracteres, com letras e números.";

function hashSenha(s) { const sal = crypto.randomBytes(16).toString("hex"); return sal + ":" + crypto.scryptSync(s, sal, 64).toString("hex"); }
function confere(s, h) {
  if (!h || !h.includes(":")) return false;
  const [sal, k] = h.split(":"), a = crypto.scryptSync(s, sal, 64), b = Buffer.from(k, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const FALSO = hashSenha("senha-falsa-para-igualar-tempo"); // evita descobrir e-mails pelo tempo de resposta

/* ----- Sessões ----- */
function abrirSessao(ctx, uid) {
  const t = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sha(t), uid, Date.now() + SESSAO_MS);
  const seguro = cfg.PRODUCAO || ctx.req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  ctx.res.setHeader("Set-Cookie", "sid=" + t + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + SESSAO_MS / 1000 + seguro);
}
function encerrarSessoes(uid) { db.prepare("DELETE FROM sessions WHERE user_id=?").run(uid); }
function usuarioDaSessao(req) {
  const t = cookie(req, "sid"); if (!t) return null;
  return db.prepare(`SELECT u.id, u.nome, u.email, u.role, u.email_verificado FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expira>? AND u.status='ACTIVE'`).get(sha(t), Date.now()) || null;
}
setInterval(() => { db.prepare("DELETE FROM sessions WHERE expira<?").run(Date.now()); db.prepare("DELETE FROM tokens_email WHERE expira<?").run(Date.now()); }, 36e5).unref();

/* ----- Tokens de e-mail (verificação e redefinição). Só o hash fica no banco. ----- */
function gerarToken(uid, tipo, horas) {
  const t = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO tokens_email VALUES(?,?,?,?,0)").run(sha(t), uid, tipo, Date.now() + horas * 36e5);
  return t;
}
function consumirToken(t, tipo) {
  const r = db.prepare("SELECT * FROM tokens_email WHERE token_hash=? AND tipo=? AND usado=0 AND expira>?").get(sha(String(t || "")), tipo, Date.now());
  if (!r) throw new Erro("Link inválido ou expirado.");
  db.prepare("UPDATE tokens_email SET usado=1 WHERE token_hash=?").run(r.token_hash);
  return r.user_id;
}
function enviarVerificacao(u) {
  const t = gerarToken(u.id, "VERIFICAR", 24);
  mail.enviar(u.email, "Confirme seu e-mail - GOATSKINS", "Olá, " + u.nome + "!\n\nConfirme seu e-mail para poder participar dos sorteios:\n" + cfg.APP_URL + "/api/verificar-email?token=" + t + "\n\nO link vale por 24 horas. Se não foi você, ignore esta mensagem.");
}

const perfil = id => db.prepare("SELECT id, nome, email, telefone, email_verificado, role, criado_em FROM users WHERE id=?").get(id);
const telefoneOk = v => { if (v == null || v === "") return null; const d = txt(String(v), 25).replace(/[^\d+]/g, ""); if (d.replace(/\D/g, "").length < 8 || d.length > 16) throw new Erro("Telefone inválido."); return d; };

const rotas = [
  ["POST", /^\/api\/registro$/, ctx => {
    const b = ctx.body, ip = ctx.ip; limite("reg:" + ip, 10, 36e5);
    const nome = txt(b.nome, 80, 2), email = txt(b.email, 120, 5).toLowerCase(), tel = telefoneOk(b.telefone);
    if (!RE.email.test(email)) throw new Erro("E-mail inválido.");
    if (!senhaOk(b.senha)) throw new Erro(SENHA_MSG);
    if (b.maior18 !== true || b.consentimento !== true) throw new Erro("Confirme que tem 18 anos ou mais e aceite os termos e a política de privacidade.");
    if (db.prepare("SELECT 1 FROM users WHERE email=? OR contato=?").get(email, email)) throw new Erro("Este e-mail já tem conta. Tente entrar ou recuperar a senha.");
    const now = agora();
    const id = Number(db.prepare("INSERT INTO users(nome,contato,email,telefone,hash,role,criado_em,atualizado_em,consentimento_em) VALUES(?,?,?,?,?,'USER',?,?,?)")
      .run(nome, email, email, tel, hashSenha(b.senha), now, now, now).lastInsertRowid);
    audit(id, "CONTA_CRIADA", null, ip); notificar(id, "Bem-vindo(a)!", "Confirme seu e-mail para poder participar dos sorteios.");
    enviarVerificacao({ id, nome, email }); abrirSessao(ctx, id); return { ok: true };
  }],
  ["POST", /^\/api\/login$/, ctx => {
    const ip = ctx.ip; limite("login:" + ip, 30, 6e5);
    const email = String(ctx.body.email || "").trim().toLowerCase(), senha = String(ctx.body.senha || "");
    const u = db.prepare("SELECT * FROM users WHERE email=? OR contato=?").get(email, email);
    if (!u) { confere(senha, FALSO); throw new Erro("E-mail ou senha incorretos.", 401); }
    if (u.status !== "ACTIVE") throw new Erro("Conta indisponível. Fale com o suporte.", 403);
    if (u.bloqueado_ate > Date.now()) throw new Erro("Conta bloqueada por tentativas excessivas. Tente novamente em alguns minutos.", 429);
    if (!confere(senha, u.hash)) {
      const f = u.falhas + 1;
      db.prepare("UPDATE users SET falhas=?, bloqueado_ate=? WHERE id=?").run(f >= MAX_FALHAS ? 0 : f, f >= MAX_FALHAS ? Date.now() + BLOQUEIO_MS : 0, u.id);
      audit(u.id, f >= MAX_FALHAS ? "CONTA_BLOQUEADA" : "LOGIN_FALHA", null, ip);
      throw new Erro("E-mail ou senha incorretos.", 401);
    }
    db.prepare("UPDATE users SET falhas=0, bloqueado_ate=0 WHERE id=?").run(u.id);
    audit(u.id, "LOGIN", null, ip); abrirSessao(ctx, u.id); return { ok: true };
  }],
  ["POST", /^\/api\/logout$/, ctx => {
    const t = cookie(ctx.req, "sid"); if (t) db.prepare("DELETE FROM sessions WHERE token=?").run(sha(t));
    ctx.res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    if (ctx.user) audit(ctx.user.id, "LOGOUT", null, ctx.ip); return { ok: true };
  }],
  ["GET", /^\/api\/verificar-email$/, ctx => {
    try {
      const uid = consumirToken(ctx.query.token, "VERIFICAR");
      db.prepare("UPDATE users SET email_verificado=1, atualizado_em=? WHERE id=?").run(agora(), uid);
      audit(uid, "EMAIL_VERIFICADO", null, ctx.ip); notificar(uid, "E-mail confirmado", "Agora você já pode participar dos sorteios.");
      return { redirect: "/?msg=email-verificado" };
    } catch (e) { if (e instanceof Erro) return { redirect: "/?msg=link-invalido" }; throw e; }
  }],
  ["POST", /^\/api\/reenviar-verificacao$/, ctx => {
    limite("reenv:" + ctx.user.id, 5, 36e5);
    const u = perfil(ctx.user.id); if (u.email_verificado) throw new Erro("Seu e-mail já está confirmado.");
    if (!u.email) throw new Erro("Esta conta não tem e-mail cadastrado.");
    enviarVerificacao(u); return { ok: true };
  }, "user"],
  ["POST", /^\/api\/esqueci-senha$/, ctx => {
    limite("esq:" + ctx.ip, 5, 36e5);
    const email = String(ctx.body.email || "").trim().toLowerCase();
    const u = db.prepare("SELECT id, nome, email FROM users WHERE email=? AND status='ACTIVE'").get(email);
    if (u) {
      const t = gerarToken(u.id, "REDEFINIR", 1); audit(u.id, "SENHA_RECUPERACAO_PEDIDA", null, ctx.ip);
      mail.enviar(u.email, "Redefinição de senha - GOATSKINS", "Olá, " + u.nome + "!\n\nPara criar uma nova senha, acesse:\n" + cfg.APP_URL + "/?redefinir=" + t + "\n\nO link vale por 1 hora. Se não foi você, ignore.");
    }
    return { ok: true }; // mesma resposta exista ou não o e-mail (não revela cadastros)
  }],
  ["POST", /^\/api\/redefinir-senha$/, ctx => {
    limite("red:" + ctx.ip, 10, 36e5);
    if (!senhaOk(ctx.body.senha)) throw new Erro(SENHA_MSG);
    const uid = tx(() => consumirToken(ctx.body.token, "REDEFINIR"));
    db.prepare("UPDATE users SET hash=?, falhas=0, bloqueado_ate=0, atualizado_em=? WHERE id=?").run(hashSenha(ctx.body.senha), agora(), uid);
    encerrarSessoes(uid); audit(uid, "SENHA_REDEFINIDA", null, ctx.ip); notificar(uid, "Senha alterada", "Sua senha foi redefinida."); return { ok: true };
  }],
  ["GET", /^\/api\/conta$/, ctx => perfil(ctx.user.id), "user"],
  ["PUT", /^\/api\/conta$/, ctx => { // só nome e telefone: papel, e-mail e status nunca vêm do navegador
    db.prepare("UPDATE users SET nome=?, telefone=?, atualizado_em=? WHERE id=?").run(txt(ctx.body.nome, 80, 2), telefoneOk(ctx.body.telefone), agora(), ctx.user.id);
    audit(ctx.user.id, "PERFIL_ATUALIZADO", null, ctx.ip); return perfil(ctx.user.id);
  }, "user"],
  ["POST", /^\/api\/conta\/senha$/, ctx => {
    limite("pw:" + ctx.user.id, 10, 36e5);
    const u = db.prepare("SELECT hash FROM users WHERE id=?").get(ctx.user.id);
    if (!confere(String(ctx.body.atual || ""), u.hash)) throw new Erro("Senha atual incorreta.", 401);
    if (!senhaOk(ctx.body.nova)) throw new Erro(SENHA_MSG);
    db.prepare("UPDATE users SET hash=?, atualizado_em=? WHERE id=?").run(hashSenha(ctx.body.nova), agora(), ctx.user.id);
    encerrarSessoes(ctx.user.id); abrirSessao(ctx, ctx.user.id); // derruba outros dispositivos
    audit(ctx.user.id, "SENHA_ALTERADA", null, ctx.ip); return { ok: true };
  }, "user"],
  ["POST", /^\/api\/conta\/excluir$/, ctx => { // LGPD: anonimiza a conta (os bilhetes ficam para manter a integridade dos sorteios)
    const u = db.prepare("SELECT hash, role FROM users WHERE id=?").get(ctx.user.id);
    if (u.role !== "USER") throw new Erro("Contas de administração não podem ser excluídas por aqui.", 403);
    if (!confere(String(ctx.body.senha || ""), u.hash)) throw new Erro("Senha incorreta.", 401);
    db.prepare("UPDATE users SET nome='Usuário removido', contato='removido-'||id, email=NULL, telefone=NULL, hash='', status='DELETED', atualizado_em=? WHERE id=?").run(agora(), ctx.user.id);
    db.prepare("DELETE FROM notifications WHERE user_id=?").run(ctx.user.id); encerrarSessoes(ctx.user.id);
    audit(ctx.user.id, "CONTA_EXCLUIDA", null, ctx.ip);
    ctx.res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); return { ok: true };
  }, "user"],
  ["GET", /^\/api\/notificacoes$/, ctx => db.prepare("SELECT id, titulo, texto, lida, criado_em FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30").all(ctx.user.id), "user"],
  ["POST", /^\/api\/notificacoes\/lidas$/, ctx => { db.prepare("UPDATE notifications SET lida=1 WHERE user_id=?").run(ctx.user.id); return { ok: true }; }, "user"]
];
module.exports = { rotas, usuarioDaSessao, hashSenha, ipDe };
