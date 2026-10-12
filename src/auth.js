/* Autenticação, conta, e-mail, notificações. */
const crypto = require("node:crypto"), registration = require("./registration");
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
  if (typeof s !== "string" || s.length > 100 || !h || !h.includes(":")) return false;
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
async function abrirSessao(ctx, uid, hashEsperado) {
  const t = crypto.randomBytes(32).toString("hex");
  // A condição é avaliada no INSERT: uma troca de senha/suspensão durante o login impede abrir a sessão.
  const r = await db.get(`INSERT INTO sessions(token,user_id,expira)
    SELECT ?,id,? FROM users WHERE id=? AND status='ACTIVE' AND email_verificado=1 AND hash=? RETURNING user_id`,
    [sha(t), Date.now() + SESSAO_MS, uid, hashEsperado]);
  if (!r) throw new Erro("Não foi possível entrar. Tente novamente.", 401);
  const seguro = cfg.PRODUCAO || ctx.req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  ctx.res.setHeader("Set-Cookie", "sid=" + t + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + SESSAO_MS / 1000 + seguro);
}
async function encerrarSessoes(uid) { await db.run("DELETE FROM sessions WHERE user_id=?", [uid]); }
async function usuarioDaSessao(req) {
  const t = cookie(req, "sid"); if (!t) return null;
  return (await db.get(`SELECT u.id, u.nome, u.email, u.role, u.email_verificado, s.mfa_until FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expira>? AND u.status='ACTIVE' AND u.email_verificado=1`, [sha(t), Date.now()])) || null;
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

const perfil = id => db.get("SELECT id, nome, email, telefone, email_verificado, role, criado_em FROM users WHERE id=?", [id]);
const telefoneOk = v => { if (v == null || v === "") return null; const d = txt(String(v), 25).replace(/[^\d+]/g, ""); if (d.replace(/\D/g, "").length < 8 || d.length > 16) throw new Erro("Telefone inválido."); return d; };

const rotas = [
  ["POST", /^\/api\/registro$/, async ctx => {
    const b = ctx.body, ip = ctx.ip; limite("reg:" + ip, 10, 36e5);
    const nome = txt(b.nome, 80, 2), email = txt(b.email, 120, 5).toLowerCase(), tel = telefoneOk(b.telefone);
    if (!RE.email.test(email)) throw new Erro("E-mail inválido.");
    if (!senhaOk(b.senha)) throw new Erro(SENHA_MSG);
    if (b.maior18 !== true || b.consentimento !== true) throw new Erro("Confirme que tem 18 anos ou mais e aceite os termos e a política de privacidade.");
    return registration.iniciar({ nome, email, telefone: tel, hash: await hashSenha(b.senha), consentimento_em: agora() }, ip);
  }],
  ["POST", /^\/api\/login$/, async ctx => {
    const ip = ctx.ip; limite("login:" + ip, 30, 6e5);
    const email = String(ctx.body.email || "").trim().toLowerCase(), senha = String(ctx.body.senha || "");
    if (senha.length > 100 || email.length > 120) throw new Erro("E-mail ou senha incorretos.", 401);
    await tx(() => registration.consumirLimite("login-email:" + sha(email), 5, BLOQUEIO_MS));
    const u = await db.get("SELECT * FROM users WHERE lower(email)=? OR lower(contato)=?", [email, email]);
    if (!u) { await confere(senha, await falso()); throw new Erro("E-mail ou senha incorretos.", 401); }
    if (u.status !== "ACTIVE") { await confere(senha, await falso()); throw new Erro("E-mail ou senha incorretos.", 401); }
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
    await db.run("DELETE FROM auth_rate_limits WHERE chave=?", ["login-email:" + sha(email)]);
    if (u.email_verificado !== 1) {
      if (!u.email) throw new Erro("Esta conta precisa de um e-mail válido. Fale com o suporte.", 403);
      return registration.iniciar({ nome: u.nome, email: u.email.toLowerCase(), telefone: u.telefone, hash: u.hash }, ip, u);
    }
    await audit(u.id, "LOGIN", null, ip); await tx(() => abrirSessao(ctx, u.id, u.hash)); return { ok: true };
  }],
  ["POST", /^\/api\/logout$/, async ctx => {
    const t = cookie(ctx.req, "sid"); if (t) await db.run("DELETE FROM sessions WHERE token=?", [sha(t)]);
    ctx.res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" + (cfg.PRODUCAO ? "; Secure" : ""));
    if (ctx.user) await audit(ctx.user.id, "LOGOUT", null, ctx.ip); return { ok: true };
  }],
  ["POST", /^\/api\/confirmar-cadastro$/, registration.confirmar],
  ["POST", /^\/api\/cancelar-cadastro$/, async ctx => {
    if (typeof ctx.body.token === "string" && /^[a-f0-9]{64}$/.test(ctx.body.token))
      await db.run("DELETE FROM pending_registrations WHERE token_hash=?", [sha(ctx.body.token)]);
    return { ok: true };
  }],
  ["POST", /^\/api\/reenviar-verificacao$/, registration.reenviar],
  ["GET", /^\/api\/verificar-email$/, async () => ({ redirect: "/?msg=link-invalido" })],
  ["POST", /^\/api\/esqueci-senha$/, async ctx => {
    limite("esq:" + ctx.ip, 5, 36e5);
    const email = String(ctx.body.email || "").trim().toLowerCase();
    if (!RE.email.test(email) || email.length > 120) throw new Erro("E-mail inválido.");
    await tx(() => registration.limiteEnvio(email, ctx.ip));
    const u = await db.get("SELECT id, nome, email FROM users WHERE lower(email)=? AND status='ACTIVE'", [email]);
    if (u) {
      const t = await gerarToken(u.id, "REDEFINIR", 1); await audit(u.id, "SENHA_RECUPERACAO_PEDIDA", null, ctx.ip);
      const entrega = await mail.enviar(u.email, "Redefinição de senha - GOATSKINS", "Olá, " + u.nome + "!\n\nPara criar uma nova senha, acesse:\n" + cfg.APP_URL + "/#redefinir=" + t + "\n\nO link vale por 1 hora. Se não foi você, ignore.");
      if (!entrega) await db.run("DELETE FROM tokens_email WHERE token_hash=?", [sha(t)]);
    }
    return { ok: true }; // mesma resposta exista ou não o e-mail (não revela cadastros)
  }],
  ["POST", /^\/api\/redefinir-senha$/, async ctx => {
    limite("red:" + ctx.ip, 10, 36e5);
    if (!senhaOk(ctx.body.senha)) throw new Erro(SENHA_MSG);
    const hash = await hashSenha(ctx.body.senha);
    const uid = await tx(async () => {
      const id = await consumirToken(ctx.body.token, "REDEFINIR");
      if (!(await db.run("UPDATE users SET hash=?, falhas=0, bloqueado_ate=0, atualizado_em=? WHERE id=? AND status='ACTIVE'", [hash, agora(), id])).changes) throw new Erro("Link inválido ou expirado.");
      await encerrarSessoes(id);
      const conta = await db.get("SELECT email,contato FROM users WHERE id=?", [id]);
      for (const valor of [conta.email, conta.contato]) if (valor) await db.run("DELETE FROM auth_rate_limits WHERE chave=?", ["login-email:" + sha(valor.trim().toLowerCase())]);
      await db.run("DELETE FROM tokens_email WHERE user_id=? AND tipo='REDEFINIR'", [id]);
      await db.run("DELETE FROM pending_registrations WHERE user_id=?", [id]);
      await audit(id, "SENHA_REDEFINIDA", null, ctx.ip); await notificar(id, "Senha alterada", "Sua senha foi redefinida.");
      return id;
    });
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
    const novoHash = await hashSenha(ctx.body.nova);
    await tx(async () => {
      if (!(await db.run("UPDATE users SET hash=?, atualizado_em=? WHERE id=? AND hash=? AND status='ACTIVE' AND email_verificado=1", [novoHash, agora(), ctx.user.id, u.hash])).changes) throw new Erro("Sua conta mudou. Entre novamente.", 401);
      await encerrarSessoes(ctx.user.id);
      await db.run("DELETE FROM tokens_email WHERE user_id=? AND tipo='REDEFINIR'", [ctx.user.id]);
    });
    await abrirSessao(ctx, ctx.user.id, novoHash); // derruba outros dispositivos
    await audit(ctx.user.id, "SENHA_ALTERADA", null, ctx.ip); await avisarSenha(ctx.user.id); return { ok: true };
  }, "user"],
  ["POST", /^\/api\/conta\/excluir$/, async ctx => { // LGPD: anonimiza a conta (os bilhetes ficam para manter a integridade dos sorteios)
    const u = await db.get("SELECT hash, role FROM users WHERE id=?", [ctx.user.id]);
    if (u.role !== "USER") throw new Erro("Contas de administração não podem ser excluídas por aqui.", 403);
    if (!(await confere(String(ctx.body.senha || ""), u.hash))) throw new Erro("Senha incorreta.", 401);
    await tx(async () => {
    // pedido Pix em andamento ou reembolso a receber: sem e-mail não há como confirmar nem devolver o valor
    if ((await db.get("SELECT COUNT(*) n FROM pedidos WHERE user_id=? AND status IN ('PENDING','REFUND_NEEDED')", [ctx.user.id])).n)
      throw new Erro("Você tem pedido Pix aguardando pagamento ou reembolso. Conclua isso antes de excluir a conta (ou fale com o suporte).", 409);
    await db.run("UPDATE users SET nome='Usuário removido', contato='removido-'||id::text, email=NULL, telefone=NULL, hash='', status='DELETED', atualizado_em=? WHERE id=?", [agora(), ctx.user.id]);
    await db.run("DELETE FROM notifications WHERE user_id=?", [ctx.user.id]); await encerrarSessoes(ctx.user.id);
    });
    await audit(ctx.user.id, "CONTA_EXCLUIDA", null, ctx.ip);
    ctx.res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" + (cfg.PRODUCAO ? "; Secure" : "")); return { ok: true };
  }, "user"],
  ["GET", /^\/api\/notificacoes$/, ctx => db.all("SELECT id, titulo, texto, lida, criado_em FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30", [ctx.user.id]), "user"],
  ["POST", /^\/api\/notificacoes\/lidas$/, async ctx => { await db.run("UPDATE notifications SET lida=1 WHERE user_id=?", [ctx.user.id]); return { ok: true }; }, "user"]
];
module.exports = { abrirSessao, rotas, usuarioDaSessao, hashSenha, confere, senhaOk, ipDe };
