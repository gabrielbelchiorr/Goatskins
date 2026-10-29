/* Cadastro pendente, sem sessão. O token aleatório identifica uma solicitação específica;
   o código fica ligado a ela por HMAC com segredo fora do banco. Nunca se troca a senha
   de uma conta existente com os dados de um novo cadastro. */
const crypto = require('node:crypto');
const cfg = require('./config'), mail = require('./mail');
const { db, tx, sha, agora, audit, notificar } = require('./db');
const { Erro } = require('./http');
const CODIGO_MS = 10 * 60e3, CADASTRO_MS = 30 * 60e3;
const mensagem = 'Se o endereço puder ser cadastrado, você receberá um código. Se já tiver uma conta, entre ou recupere sua senha. Confira também o spam.';
const digest = (tokenHash, codigo) => crypto.createHmac('sha256', cfg.EMAIL_CODE_SECRET).update(tokenHash + ':' + codigo).digest('hex');
const gerarCodigo = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const tokenValido = t => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);
const invalido = () => new Erro('Código inválido, expirado ou limite de tentativas atingido. Reenvie o código ou reinicie o cadastro.', 400);

// Chamar dentro de tx. Os limites persistem entre reinícios e são compartilhados entre instâncias.
async function consumirLimite(chave, max, janela, intervalo = 0, mensagemLimite = "Muitas tentativas. Aguarde alguns minutos.") {
  const now = Date.now();
  const r = await db.get(`INSERT INTO auth_rate_limits(chave,inicio,n,proximo,expira) VALUES(?,?,1,?,?)
    ON CONFLICT(chave) DO UPDATE SET
      inicio=CASE WHEN auth_rate_limits.expira<=? THEN ? ELSE auth_rate_limits.inicio END,
      n=CASE WHEN auth_rate_limits.expira<=? THEN 1 ELSE auth_rate_limits.n+1 END,
      proximo=?, expira=CASE WHEN auth_rate_limits.expira<=? THEN ? ELSE auth_rate_limits.expira END
    WHERE auth_rate_limits.expira<=? OR (auth_rate_limits.n<? AND auth_rate_limits.proximo<=?) RETURNING n`,
    [chave, now, now + intervalo, now + janela, now, now, now, now + intervalo, now, now + janela, now, max, now]);
  if (!r) throw new Erro(mensagemLimite, 429);
}
async function limiteEnvio(email, ip) {
  await consumirLimite('email:' + sha(email), 5, 36e5, 60e3, 'Aguarde pelo menos 60 segundos entre envios. Limite de 5 mensagens por hora por e-mail.');
  if (!cfg.TESTE) {
    await consumirLimite('envio-ip:' + sha(String(ip)), 20, 36e5);
    await consumirLimite('envio-global', 200, 36e5);
  }
}
async function limpar() {
  const now = Date.now();
  await db.run('DELETE FROM pending_registrations WHERE cadastro_expira<=?', [now]);
  await db.run('DELETE FROM auth_rate_limits WHERE expira<=?', [now]);
  await db.run('DELETE FROM phone_verifications WHERE expira<=?', [now]);
  await db.run('DELETE FROM admin_mfa WHERE enabled=0 AND pending_expira<=?', [now]);
}
async function entregar(p, codigo, avisoConta = false) {
  try {
    const resultado = await mail.enviarObrigatorio(p.email, 'Confirmação de cadastro - GOATSKINS', avisoConta
      ? 'Recebemos uma solicitação de cadastro para este endereço. Se você já tem uma conta, entre com sua senha ou use Esqueci minha senha em ' + cfg.APP_URL + '. Se não foi você, ignore esta mensagem.'
      : 'Seu código de confirmação GOATSKINS é: ' + codigo + '\n\nVálido por 10 minutos. Digite-o na tela em que solicitou o cadastro. Não compartilhe este código.\n\nSe não foi você, ignore. Nenhuma conta nova foi ativada.');
    await db.run('UPDATE pending_registrations SET enviado=1 WHERE token_hash=? AND codigo_hash=?', [p.token_hash, p.codigo_hash]);
    return resultado;
  } catch (e) {
    // Inclui timeout: mesmo que o provedor tenha aceitado a mensagem, este código não será utilizável.
    if (!avisoConta) await db.run('UPDATE pending_registrations SET enviado=0 WHERE token_hash=? AND codigo_hash=?', [p.token_hash, p.codigo_hash]);
    console.error('[cadastro-email]', e.message);
    throw new Erro('Não foi possível concluir o envio agora. Aguarde 60 segundos e tente novamente. Nenhuma conta foi ativada.', 503);
  }
}
async function iniciar(dados, ip, legacyUser = null) {
  const token = crypto.randomBytes(32).toString('hex'), tokenHash = sha(token), codigo = gerarCodigo(), now = Date.now();
  const p = { ...dados, token_hash: tokenHash, codigo_hash: digest(tokenHash, codigo) };
  const avisoConta = await tx(async () => {
    await limiteEnvio(p.email, ip);
    const existente = await db.get('SELECT id, email, hash, status, email_verificado FROM users WHERE lower(email)=? OR lower(contato)=?', [p.email, p.email]);
    if (legacyUser && (!existente || existente.id !== legacyUser.id || existente.hash !== legacyUser.hash || existente.status !== 'ACTIVE' || existente.email_verificado === 1)) throw invalido();
    const aviso = !!existente && !legacyUser; // mesmo fluxo de reenvio, sem revelar existência pela API
    await db.run(`INSERT INTO pending_registrations(token_hash,email,nome,telefone,password_hash,consentimento_em,user_id,codigo_hash,expira,cadastro_expira,criado_em,aviso)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [p.token_hash, p.email, p.nome, p.telefone || null, p.hash, p.consentimento_em || null,
      legacyUser ? legacyUser.id : null, p.codigo_hash, now + CODIGO_MS, now + CADASTRO_MS, agora(), aviso ? 1 : 0]);
    return aviso;
  });
  const entrega = await entregar(p, codigo, avisoConta);
  return { ok: true, pendente: true, token, expira_em: now + CODIGO_MS, reenviar_em: now + 60e3,
    cadastro_expira_em: now + CADASTRO_MS, mensagem, simulado: entrega.simulado };
}
async function reenviar(ctx) {
  if (!tokenValido(ctx.body.token)) throw invalido();
  const tokenHash = sha(ctx.body.token), codigo = gerarCodigo();
  const p = await tx(async () => {
    const p = await db.get('SELECT * FROM pending_registrations WHERE token_hash=? FOR UPDATE', [tokenHash]);
    if (!p || p.cadastro_expira <= Date.now() || p.tentativas >= 5) throw invalido();
    await limiteEnvio(p.email, ctx.ip);
    let novo = codigo;
    while (digest(tokenHash, novo) === p.codigo_hash) novo = gerarCodigo();
    p.codigo = novo; p.codigo_hash = digest(tokenHash, novo); p.expira = Math.min(Date.now() + CODIGO_MS, p.cadastro_expira);
    await db.run('UPDATE pending_registrations SET codigo_hash=?, expira=?, enviado=0 WHERE token_hash=?', [p.codigo_hash, p.expira, tokenHash]);
    return p;
  });
  const entrega = await entregar(p, p.codigo, p.aviso === 1);
  return { ok: true, expira_em: p.expira, reenviar_em: Date.now() + 60e3, simulado: entrega.simulado };
}
async function confirmar(ctx) {
  if (!tokenValido(ctx.body.token)) throw invalido();
  // Erros de código retornam de dentro da transação; lançar antes do commit apagaria a contagem de falhas.
  const resultado = await tx(async () => {
    if (!cfg.TESTE) await consumirLimite('verificar-ip:' + sha(String(ctx.ip)), 60, 36e5);
    const p = await db.get('SELECT * FROM pending_registrations WHERE token_hash=? FOR UPDATE', [sha(ctx.body.token)]);
    if (!p || p.cadastro_expira <= Date.now() || p.expira <= Date.now() || p.tentativas >= 5 || !p.enviado) return false;
    await consumirLimite('verificar-email:' + sha(p.email), 15, 36e5);
    await db.run('UPDATE pending_registrations SET tentativas=tentativas+1 WHERE token_hash=?', [p.token_hash]);
    const codigo = typeof ctx.body.codigo === 'string' ? ctx.body.codigo : '';
    if (!/^\d{6}$/.test(codigo) || !crypto.timingSafeEqual(Buffer.from(digest(p.token_hash, codigo), 'hex'), Buffer.from(p.codigo_hash, 'hex'))) return false;
    if (p.aviso) return false;
    const now = agora(); let uid;
    if (p.user_id) {
      // Preserva ID, senha, papel e bilhetes antigos. Uma troca de senha invalida a solicitação anterior.
      const r = await db.get(`UPDATE users SET email_verificado=1, atualizado_em=?
        WHERE id=? AND lower(email)=? AND hash=? AND status='ACTIVE' AND email_verificado=0 RETURNING id`, [now, p.user_id, p.email, p.password_hash]);
      if (!r) return false;
      uid = r.id;
    } else {
      if (await db.get('SELECT 1 FROM users WHERE lower(email)=? OR lower(contato)=?', [p.email, p.email])) return false;
      const r = await db.get(`INSERT INTO users(nome,contato,email,telefone,hash,role,email_verificado,criado_em,atualizado_em,consentimento_em)
        VALUES(?,?,?,?,?,'USER',1,?,?,?) ON CONFLICT DO NOTHING RETURNING id`, [p.nome, p.email, p.email, p.telefone, p.password_hash, now, now, p.consentimento_em]);
      if (!r) return false;
      uid = r.id;
      await db.run('UPDATE users SET celular=? WHERE id=?', [p.telefone,uid]);
      await audit(uid, 'CONTA_CRIADA', 'após confirmação do e-mail', ctx.ip);
    }
    await db.run('DELETE FROM pending_registrations WHERE email=?', [p.email]);
    await db.run('DELETE FROM sessions WHERE user_id=?', [uid]);
    await audit(uid, 'EMAIL_VERIFICADO', null, ctx.ip);
    await notificar(uid, 'E-mail confirmado', 'Entre para concluir o cadastro e participar dos sorteios.');
    return true;
  });
  if (!resultado) throw invalido();
  return { ok: true, mensagem: 'E-mail confirmado. Entre com sua senha.' }; // sem login automático
}
module.exports = { iniciar, reenviar, confirmar, limpar, limiteEnvio, consumirLimite };
