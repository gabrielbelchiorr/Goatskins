/* Autenticação, conta, e-mail, notificações. */
const crypto = require("node:crypto");
const cfg = require("./config"), mail = require("./mail");
const { db, sha, agora, tx, audit, notificar } = require("./db");
const { Erro, RE, txt, limite, cookie, ipDe } = require("./http");

const MAX_FALHAS = 5, BLOQUEIO_MS = 15 * 60e3, SESSAO_MS = 7 * 864e5;
const senhaOk = s => typeof s === "string" && s.length >= 8 && s.length <= 100 && /[a-zA-Z]/.test(s) && /\d/.test(s);
const SENHA_MSG = "A senha precisa ter 8 ou mais caracteres, com letras e números.";

/* scrypt ASSÍNCRONO (roda no pool de threads do libuv): o scryptSync travava o servidor inteiro ~50-100 ms a cada login/cadastro,
   então uma enxurrada de tentativas de login derrubava o site para todo mundo. O formato do hash guardado ("sal:hex") não mudou. */
const scrypt = (s, sal) => new Promise((ok, falha) => crypto.scrypt(s, sal, 64, (e, k) => e ? falha(e) : ok(k)));
async function hashSenha(s) { const sal = crypto.randomBytes(16).toString("hex"); return sal + ":" + (await scrypt(s, sal)).toString("hex"); }
async function confere(s, h) {
  if (!h || !h.includes(":")) return false;
  const [sal, k] = h.split(":"), a = await scrypt(s, sal), b = Buffer.from(k, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
let FALSO = null; // hash de uma senha qualquer: usado quando o e-mail não existe, para o tempo de resposta não revelar quem tem conta
const falso = async () => FALSO || (FALSO = await hashSenha("senha-falsa-para-igualar-tempo"));
/* Aviso de segurança por e-mail (senha alterada). Nunca derruba a requisição. */
async function avisarSenha(uid) {
  const u = await db.get("SELECT nome, email FROM users WHERE id=?", [uid]);
  if (u && u.email) mail.enviar(u.email, "Sua senha foi alterada - GOATSKINS", "Olá, " + u.nome + "!\n\nA senha da sua conta foi alterada agora há pouco. Se foi você, não precisa fazer nada.\nSe NÃO foi você, use \"Esqueci minha senha\" no site imediatamente e fale com o suporte.");
}

/* ----- Sessões ----- */
async function abrirSessao(ctx, uid) {
  const t = crypto.randomBytes(32).toString("hex");
  await db.run("INSERT INTO sessions(token,user_id,expira) VALUES(?,?,?)", [sha(t), uid, Date.now() + SESSAO_MS]);
  const seguro = cfg.PRODUCAO || ctx.req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  ctx.res.setHeader("Set-Cookie", "sid=" + t + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + SESSAO_MS / 1000 + seguro);
}
async function encerrarSessoes(uid) { await db.run("DELETE FROM sessions WHERE user_id=?", [uid]); }
async function usuarioDaSessao(req) {
  const t = cookie(req, "sid"); if (!t) return null;
  return (await db.get(`SELECT u.id, u.nome, u.email, u.role, u.email_verificado FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expira>? AND u.status='ACTIVE'`, [sha(t), Date.now()])) || null;
}
setInterval(() => {
  Promise.all([db.run("DELETE FROM sessions WHERE expira<?", [Date.now()]), db.run("DELETE FROM tokens_email WHERE expira<?", [Date.now()])])
    .catch(e => console.error("limpeza de sessões:", e.message));
}, 36e5).unref();

/* ----- Tokens de e-mail (verificação e redefinição). Só o hash fica no banco. ----- */
async function gerarToken(uid, tipo, horas) {
  const t = crypto.randomBytes(32).toString("hex");
  await db.run("INSERT INTO tokens_email(token_hash,user_id,tipo,expira,usado) VALUES(?,?,?,?,0)", [sha(t), uid, tipo, Date.now() + horas * 36e5]);
  return t;
}
async function consumirToken(t, tipo) {
  const r = await db.get("SELECT * FROM tokens_email WHERE token_hash=? AND tipo=? AND usado=0 AND expira>?", [sha(String(t || "")), tipo, Date.now()]);
  if (!r) throw new Erro("Link inválido ou expirado.");
  // o "AND usado=0" torna o consumo atômico: se duas requisições usarem o mesmo link ao mesmo tempo, só uma passa
  if (!(await db.run("UPDATE tokens_email SET usado=1 WHERE token_hash=? AND usado=0", [r.token_hash])).changes) throw new Erro("Link inválido ou expirado.");
  return r.user_id;
}
async function enviarVerificacao(u) {
  const t = await gerarToken(u.id, "VERIFICAR", 24);
  mail.enviar(u.email, "Confirme seu e-mail - GOATSKINS", "Olá, " + u.nome + "!\n\nConfirme seu e-mail para poder participar dos sorteios:\n" + cfg.APP_URL + "/api/verificar-email?token=" + t + "\n\nO link vale por 24 horas. Se não foi você, ignore esta mensagem.");
}

const perfil = id => db.get("SELECT id, nome, email, telefone, email_verificado, role, criado_em FROM users WHERE id=?", [id]);
const telefoneOk = v => { if (v == null || v === "") return null; const d = txt(String(v), 25).replace(/[^\d+]/g, ""); if (d.replace(/\D/g, "").length < 8 || d.length > 16) throw new Erro("Telefone inválido."); return d; };

const rotas = [
  ["POST", /^\/api\/registro$/, async ctx => {
    const b = ctx.body, ip = ctx.ip; limite("reg:" + ip, 10, 36e5);
    const nome = txt(b.nome, 80, 2), email = txt(b.email, 120, 5).toLowerCase(), tel = telefoneOk(b.telefone);
    if (!RE.email.test(email)) throw new Erro("E-mail inválido.");
    if (!senhaOk(b.senha)) throw new Erro(SENHA_MSG);
    if (b.maior18 !== true || b.consentimento !== true) throw new Erro("Confirme que tem 18 anos ou mais e aceite os termos e a política de privacidade.");
    const JA_EXISTE = "Este e-mail já tem conta. Tente entrar ou recuperar a senha.";
    if (await db.get("SELECT 1 FROM users WHERE email=? OR contato=?", [email, email])) throw new Erro(JA_EXISTE);
    const now = agora(); let id;
    try {
      id = await db.insert("INSERT INTO users(nome,contato,email,telefone,hash,role,criado_em,atualizado_em,consentimento_em) VALUES(?,?,?,?,?,'USER',?,?,?)",
        [nome, email, email, tel, await hashSenha(b.senha), now, now, now]);
    } catch (e) { if (e.code === "23505") throw new Erro(JA_EXISTE); throw e; } // duas inscrições simultâneas com o mesmo e-mail
    await audit(id, "CONTA_CRIADA", null, ip); await notificar(id, "Bem-vindo(a)!", "Confirme seu e-mail para poder participar dos sorteios.");
    await enviarVerificacao({ id, nome, email }); await abrirSessao(ctx, id); return { ok: true };
  }],
  ["POST", /^\/api\/login$/, async ctx => {
    const ip = ctx.ip; limite("login:" + ip, 30, 6e5);
    const email = String(ctx.body.email || "").trim().toLowerCase(), senha = String(ctx.body.senha || "");
    const u = await db.get("SELECT * FROM users WHERE email=? OR contato=?", [email, email]);
    if (!u) { await confere(senha, await falso()); throw new Erro("E-mail ou senha incorretos.", 401); }
    if (u.status !== "ACTIVE") { await confere(senha, await falso()); throw new Erro("Conta indisponível. Fale com o suporte.", 403); }
    if (u.bloqueado_ate > Date.now()) { await confere(senha, await falso()); throw new Erro("Conta bloqueada por tentativas excessivas. Tente novamente em alguns minutos.", 429); }
    /* A tentativa é RESERVADA de forma atômica ANTES de conferir a senha. Assim, mesmo com centenas de requisições simultâneas,
       só MAX_FALHAS senhas por janela chegam a ser testadas (antes: "lê falhas, soma no JS, grava" deixava todas passarem com falhas=0). */
    const agoraMs = Date.now();
    const reserva = await db.get(`UPDATE users SET falhas = CASE WHEN falhas + 1 >= ? THEN 0 ELSE falhas + 1 END,
      bloqueado_ate = CASE WHEN falhas + 1 >= ? THEN ?::bigint ELSE 0 END WHERE id=? AND bloqueado_ate <= ? RETURNING bloqueado_ate`, [MAX_FALHAS, MAX_FALHAS, agoraMs + BLOQUEIO_MS, u.id, agoraMs]);
    if (!reserva) { await confere(senha, await falso()); throw new Erro("Conta bloqueada por tentativas excessivas. Tente novamente em alguns minutos.", 429); }
    if (!(await confere(senha, u.hash))) {
      await audit(u.id, reserva.bloqueado_ate > agoraMs ? "CONTA_BLOQUEADA" : "LOGIN_FALHA", null, ip);
      throw new Erro("E-mail ou senha incorretos.", 401);
    }
    await db.run("UPDATE users SET falhas=0, bloqueado_ate=0 WHERE id=?", [u.id]);
    await audit(u.id, "LOGIN", null, ip); await abrirSessao(ctx, u.id); return { ok: true };
  }],
  ["POST", /^\/api\/logout$/, async ctx => {
    const t = cookie(ctx.req, "sid"); if (t) await db.run("DELETE FROM sessions WHERE token=?", [sha(t)]);
    ctx.res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    if (ctx.user) await audit(ctx.user.id, "LOGOUT", null, ctx.ip); return { ok: true };
  }],
  ["GET", /^\/api\/verificar-email$/, async ctx => {
    try {
      const uid = await consumirToken(ctx.query.token, "VERIFICAR");
      await db.run("UPDATE users SET email_verificado=1, atualizado_em=? WHERE id=?", [agora(), uid]);
      await audit(uid, "EMAIL_VERIFICADO", null, ctx.ip); await notificar(uid, "E-mail confirmado", "Agora você já pode participar dos sorteios.");
      return { redirect: "/?msg=email-verificado" };
    } catch (e) { if (e instanceof Erro) return { redirect: "/?msg=link-invalido" }; throw e; }
  }],
  ["POST", /^\/api\/reenviar-verificacao$/, async ctx => {
    limite("reenv:" + ctx.user.id, 5, 36e5);
    const u = await perfil(ctx.user.id); if (u.email_verificado) throw new Erro("Seu e-mail já está confirmado.");
    if (!u.email) throw new Erro("Esta conta não tem e-mail cadastrado.");
    await enviarVerificacao(u); return { ok: true };
  }, "user"],
  ["POST", /^\/api\/esqueci-senha$/, async ctx => {
    limite("esq:" + ctx.ip, 5, 36e5);
    const email = String(ctx.body.email || "").trim().toLowerCase();
    const u = await db.get("SELECT id, nome, email FROM users WHERE email=? AND status='ACTIVE'", [email]);
    if (u) {
      const t = await gerarToken(u.id, "REDEFINIR", 1); await audit(u.id, "SENHA_RECUPERACAO_PEDIDA", null, ctx.ip);
      mail.enviar(u.email, "Redefinição de senha - GOATSKINS", "Olá, " + u.nome + "!\n\nPara criar uma nova senha, acesse:\n" + cfg.APP_URL + "/#redefinir=" + t + "\n\nO link vale por 1 hora. Se não foi você, ignore.");
    }
    return { ok: true }; // mesma resposta exista ou não o e-mail (não revela cadastros)
  }],
  ["POST", /^\/api\/redefinir-senha$/, async ctx => {
    limite("red:" + ctx.ip, 10, 36e5);
    if (!senhaOk(ctx.body.senha)) throw new Erro(SENHA_MSG);
    const uid = await tx(() => consumirToken(ctx.body.token, "REDEFINIR"));
    await db.run("UPDATE users SET hash=?, falhas=0, bloqueado_ate=0, atualizado_em=? WHERE id=?", [await hashSenha(ctx.body.senha), agora(), uid]);
    await encerrarSessoes(uid); await audit(uid, "SENHA_REDEFINIDA", null, ctx.ip); await notificar(uid, "Senha alterada", "Sua senha foi redefinida.");
    await avisarSenha(uid); return { ok: true };
  }],
  ["GET", /^\/api\/conta$/, ctx => perfil(ctx.user.id), "user"],
  ["PUT", /^\/api\/conta$/, async ctx => { // só nome e telefone: papel, e-mail e status nunca vêm do navegador
    await db.run("UPDATE users SET nome=?, telefone=?, atualizado_em=? WHERE id=?", [txt(ctx.body.nome, 80, 2), telefoneOk(ctx.body.telefone), agora(), ctx.user.id]);
    await audit(ctx.user.id, "PERFIL_ATUALIZADO", null, ctx.ip); return perfil(ctx.user.id);
  }, "user"],
  ["POST", /^\/api\/conta\/senha$/, async ctx => {
    limite("pw:" + ctx.user.id, 10, 36e5);
    const u = await db.get("SELECT hash FROM users WHERE id=?", [ctx.user.id]);
    if (!(await confere(String(ctx.body.atual || ""), u.hash))) throw new Erro("Senha atual incorreta.", 401);
    if (!senhaOk(ctx.body.nova)) throw new Erro(SENHA_MSG);
    await db.run("UPDATE users SET hash=?, atualizado_em=? WHERE id=?", [await hashSenha(ctx.body.nova), agora(), ctx.user.id]);
    await encerrarSessoes(ctx.user.id); await abrirSessao(ctx, ctx.user.id); // derruba outros dispositivos
    await audit(ctx.user.id, "SENHA_ALTERADA", null, ctx.ip); await avisarSenha(ctx.user.id); return { ok: true };
  }, "user"],
  ["POST", /^\/api\/conta\/excluir$/, async ctx => { // LGPD: anonimiza a conta (os bilhetes ficam para manter a integridade dos sorteios)
    const u = await db.get("SELECT hash, role FROM users WHERE id=?", [ctx.user.id]);
    if (u.role !== "USER") throw new Erro("Contas de administração não podem ser excluídas por aqui.", 403);
    if (!(await confere(String(ctx.body.senha || ""), u.hash))) throw new Erro("Senha incorreta.", 401);
    // pedido Pix em andamento ou reembolso a receber: sem e-mail não há como confirmar nem devolver o valor
    if ((await db.get("SELECT COUNT(*) n FROM pedidos WHERE user_id=? AND status IN ('PENDING','REFUND_NEEDED')", [ctx.user.id])).n)
      throw new Erro("Você tem pedido Pix aguardando pagamento ou reembolso. Conclua isso antes de excluir a conta (ou fale com o suporte).", 409);
    await db.run("UPDATE users SET nome='Usuário removido', contato='removido-'||id::text, email=NULL, telefone=NULL, hash='', status='DELETED', atualizado_em=? WHERE id=?", [agora(), ctx.user.id]);
    await db.run("DELETE FROM notifications WHERE user_id=?", [ctx.user.id]); await encerrarSessoes(ctx.user.id);
    await audit(ctx.user.id, "CONTA_EXCLUIDA", null, ctx.ip);
    ctx.res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); return { ok: true };
  }, "user"],
  ["GET", /^\/api\/notificacoes$/, ctx => db.all("SELECT id, titulo, texto, lida, criado_em FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30", [ctx.user.id]), "user"],
  ["POST", /^\/api\/notificacoes\/lidas$/, async ctx => { await db.run("UPDATE notifications SET lida=1 WHERE user_id=?", [ctx.user.id]); return { ok: true }; }, "user"]
];
module.exports = { rotas, usuarioDaSessao, hashSenha, confere, senhaOk, ipDe };
