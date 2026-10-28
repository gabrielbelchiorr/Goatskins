/* Recuperação assíncrona durável, sem fila externa ou token em claro no banco.
   A rota grava o MESMO job antes de consultar usuários. Resend nunca participa do tempo HTTP.
   EMAIL_CODE_SECRET deve ser forte e igual em todas as instâncias (validado pela configuração). */
const crypto = require('node:crypto');
const cfg = require('./config'), mail = require('./mail');
const { db, tx, sha, audit } = require('./db');
const VALIDADE_MS = 36e5, LEASE_MS = 60000, MAX_TENTATIVAS = 5;
const tokenDe = id => crypto.createHmac('sha256', cfg.EMAIL_CODE_SECRET)
  .update('goatskins:password-recovery:v1:' + id).digest('hex');
const log = evento => console.error(JSON.stringify({ area: 'recuperacao', evento }));

// Chamar na mesma tx dos limites: falha no INSERT também desfaz o consumo persistente.
async function enfileirar(email, ip) {
  const now = Date.now();
  await db.run(`INSERT INTO password_recovery_jobs(id,email,ip,criado_em,expira,proximo)
    VALUES(?,?,?,?,?,?)`, [crypto.randomBytes(32).toString('hex'), email, ip || null, now, now + VALIDADE_MS, now]);
}
async function cancelar(email) {
  if (email) await db.run('DELETE FROM password_recovery_jobs WHERE email=?', [email.trim().toLowerCase()]);
}
async function limpar() {
  await db.run('DELETE FROM password_recovery_jobs WHERE expira<=? OR (tentativas>=? AND lease_ate<=?)',
    [Date.now(), MAX_TENTATIVAS, Date.now()]);
}

// Reserva curta e serializada entre instâncias. Nenhuma chamada de rede dentro da tx.
async function reservar() {
  return tx(async () => {
    const now = Date.now();
    const j = await db.get(`SELECT * FROM password_recovery_jobs
      WHERE expira>? AND proximo<=? AND lease_ate<=? AND tentativas<?
      ORDER BY criado_em,id LIMIT 1 FOR UPDATE`, [now, now, now, MAX_TENTATIVAS]);
    if (!j) return null;
    const token = tokenDe(j.id);
    if (!j.token_hash) {
      const u = await db.get("SELECT id,nome,email FROM users WHERE lower(email)=? AND status='ACTIVE'", [j.email]);
      if (!u) {
        await db.run('DELETE FROM password_recovery_jobs WHERE id=?', [j.id]);
        return { descartado: true };
      }
      j.token_hash = sha(token);
      // Snapshot sem o token: retentativas usam exatamente o mesmo corpo e remetente, mesmo após editar o perfil/config.
      j.contexto = JSON.stringify({ nome: u.nome, email: u.email, from: cfg.EMAIL_FROM, url: cfg.APP_URL });
      await db.run("INSERT INTO tokens_email(token_hash,user_id,tipo,expira,usado) VALUES(?,?,'REDEFINIR',?,0)",
        [j.token_hash, u.id, j.expira]);
      await audit(u.id, 'SENHA_RECUPERACAO_PEDIDA', null, j.ip);
    } else if (sha(token) !== j.token_hash) {
      // Rotação do segredo: nunca remeter capacidade diferente da que está registrada.
      await db.run('DELETE FROM password_recovery_jobs WHERE id=?', [j.id]);
      log('SEGREDO_ALTERADO_PEDIDO_DESCARTADO');
      return { descartado: true };
    }
    j.dono = crypto.randomBytes(16).toString('hex');
    j.tentativas++;
    await db.run(`UPDATE password_recovery_jobs SET token_hash=?,contexto=?,dono=?,tentativas=?,lease_ate=? WHERE id=?`,
      [j.token_hash, j.contexto, j.dono, j.tentativas, now + LEASE_MS, j.id]);
    return j;
  });
}

async function processarUma() {
  const j = await reservar();
  if (!j) return false;
  if (j.descartado) return true;
  try {
    // Reduz entregas inúteis se houve reset/exclusão depois da reserva. A capacidade é revalidada no consumo.
    const ativo = await db.get(`SELECT 1 FROM password_recovery_jobs j JOIN tokens_email t ON t.token_hash=j.token_hash
      JOIN users u ON u.id=t.user_id WHERE j.id=? AND j.dono=? AND j.lease_ate>? AND t.usado=0 AND t.expira>?
      AND u.status='ACTIVE' AND lower(u.email)=j.email`, [j.id, j.dono, Date.now(), Date.now()]);
    if (!ativo) {
      await db.run('DELETE FROM password_recovery_jobs WHERE id=? AND dono=?', [j.id, j.dono]);
      return true;
    }
    const p = JSON.parse(j.contexto);
    await mail.enviarObrigatorio(p.email, 'Redefinição de senha - GOATSKINS',
      'Olá, ' + p.nome + '!\n\nPara criar uma nova senha, acesse:\n' + p.url + '/#redefinir=' + tokenDe(j.id) +
      '\n\nO link vale por 1 hora a partir da solicitação. Se não foi você, ignore.',
      { from: p.from, idempotencyKey: 'password-recovery/' + j.id });
    await db.run('DELETE FROM password_recovery_jobs WHERE id=? AND dono=?', [j.id, j.dono]);
  } catch (_) {
    // Timeout pode ocorrer APÓS a aceitação. Preservar token e repetir o mesmo envio idempotente.
    // Até no esgotamento, o token permanece válido até expirar: uma mensagem já aceita não perde seu link.
    const proximo = Date.now() + Math.min(300000, 5000 * 2 ** (j.tentativas - 1));
    if (j.tentativas >= MAX_TENTATIVAS || proximo >= j.expira) {
      await db.run('DELETE FROM password_recovery_jobs WHERE id=? AND dono=?', [j.id, j.dono]);
      log('ENTREGA_ESGOTADA');
    } else {
      await db.run('UPDATE password_recovery_jobs SET lease_ate=0,dono=NULL,proximo=? WHERE id=? AND dono=?',
        [proximo, j.id, j.dono]);
      log('ENTREGA_REAGENDADA');
    }
  }
  return true;
}

// Polling independente da resposta HTTP; o request não acorda nem aguarda o worker.
// A fila é a garantia de persistência; shutdown abrupto retoma após o lease.
function iniciarProcessador() {
  let encerrando = false, emCurso = null, ultimaLimpeza = 0;
  function tick() {
    if (encerrando || emCurso) return;
    emCurso = (async () => {
      if (Date.now() - ultimaLimpeza >= 60000) { await limpar(); ultimaLimpeza = Date.now(); }
      for (let i = 0; i < 10 && !encerrando; i++) if (!(await processarUma())) break;
    })().catch(() => log('FALHA_PROCESSADOR')).finally(() => { emCurso = null; });
  }
  const timer = setInterval(tick, 1000); timer.unref();
  tick(); // Recupera trabalho persistido no restart, inclusive sem novas requisições.
  return async () => { encerrando = true; clearInterval(timer); await emCurso; };
}
module.exports = { enfileirar, cancelar, limpar, processarUma, iniciarProcessador };
