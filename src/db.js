/* Banco PostgreSQL (biblioteca "pg") + migrações versionadas (tabela schema_migrations).
   Uso nos outros módulos (tudo é assíncrono, lembre do await):
     db.get(sql, [params])     -> primeira linha ou undefined
     db.all(sql, [params])     -> array de linhas
     db.run(sql, [params])     -> { changes }   (linhas afetadas)
     db.insert(sql, [params])  -> id gerado (acrescenta RETURNING id)
   Escreva os parâmetros como "?" : eles são convertidos para $1, $2... (não use "?" dentro de texto SQL).
   tx(fn): tudo o que fn fizer com db.* usa a MESMA conexão e roda numa transação (COMMIT no fim, ROLLBACK se der erro). */
const { Pool, types } = require("pg"), { AsyncLocalStorage } = require("node:async_hooks"), crypto = require("node:crypto");
const cfg = require("./config");

types.setTypeParser(20, v => Number(v));    // BIGINT / COUNT(*) / BIGSERIAL chegam como número (todos cabem em 2^53)
types.setTypeParser(1700, v => parseFloat(v)); // NUMERIC (ex.: SUM, divisões) também como número

// statement_timeout / idle_in_transaction_session_timeout: uma consulta travada ou uma transação esquecida aberta nunca segura a trava de escrita para sempre.
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: cfg.PG_POOL_MAX, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
  statement_timeout: 20000, idle_in_transaction_session_timeout: 30000, application_name: "goatskins",
  ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: false } : undefined });
pool.on("error", e => console.error("[pg] erro em conexão ociosa:", e.message)); // sem isso um erro de rede derrubaria o processo

const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const agora = () => new Date().toISOString();

/* ----- consultas ----- */
const als = new AsyncLocalStorage();           // guarda a conexão da transação em andamento
const alvo = () => als.getStore() || pool;
const conv = sql => { let i = 0; return sql.replace(/\?/g, () => "$" + (++i)); };
const all = async (sql, p = []) => (await alvo().query(conv(sql), p)).rows;
const get = async (sql, p = []) => (await all(sql, p))[0];
const run = async (sql, p = []) => ({ changes: (await alvo().query(conv(sql), p)).rowCount });
const insert = async (sql, p = []) => (await alvo().query(conv(sql) + " RETURNING id", p)).rows[0].id;
const db = { all, get, run, insert };

/* Transação com trava de escrita: o pg_advisory_xact_lock faz as transações rodarem uma por vez, como o
   BEGIN IMMEDIATE do SQLite fazia. Isso mantém as regras de "ler, conferir e gravar" (limites por pessoa, reservas
   de números) livres de corrida. As travas finas (UNIQUE/PRIMARY KEY) continuam como garantia final. */
const LOCK_ESCRITA = 727401, LOCK_MIGRACAO = 727402;
async function tx(fn) {
  if (als.getStore()) return fn();               // já dentro de uma transação: participa dela
  const c = await pool.connect(); let quebrada = false;
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(" + LOCK_ESCRITA + ")");
    const r = await als.run(c, fn);
    await c.query("COMMIT"); return r;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (_) { quebrada = true; }
    throw e;
  } finally { c.release(quebrada); }
}

/* ----- esquema ----- */
const MIGRACOES = [
/* 1: esquema completo (equivale ao estado final das migrações 1-4 do tempo do SQLite) */ `
CREATE TABLE users(id BIGSERIAL PRIMARY KEY, nome TEXT NOT NULL, contato TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'USER',
  email TEXT, telefone TEXT, email_verificado INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', falhas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate BIGINT NOT NULL DEFAULT 0, consentimento_em TEXT, criado_em TEXT NOT NULL DEFAULT '', atualizado_em TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX ux_users_email ON users(email) WHERE email IS NOT NULL;
CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expira BIGINT NOT NULL);
CREATE TABLE tokens_email(token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tipo TEXT NOT NULL, expira BIGINT NOT NULL, usado INTEGER NOT NULL DEFAULT 0);
CREATE TABLE audit_logs(id BIGSERIAL PRIMARY KEY, quando TEXT NOT NULL, user_id BIGINT, acao TEXT NOT NULL, detalhe TEXT, ip TEXT);
CREATE TABLE notifications(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, titulo TEXT NOT NULL, texto TEXT NOT NULL, lida INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL);
CREATE TABLE campaigns(id BIGSERIAL PRIMARY KEY, premio TEXT NOT NULL, desgaste TEXT NOT NULL DEFAULT '', descricao TEXT NOT NULL DEFAULT '', valor DOUBLE PRECISION NOT NULL DEFAULT 0,
  cor TEXT NOT NULL DEFAULT '#b3263a', fim TEXT NOT NULL, max INTEGER NOT NULL, max_por_usuario INTEGER NOT NULL DEFAULT 1, foto TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN', seed TEXT, commit_hash TEXT, criado_por BIGINT, criado_em TEXT NOT NULL DEFAULT '',
  preco_centavos INTEGER NOT NULL DEFAULT 0 CHECK(preco_centavos >= 0));
CREATE TABLE tickets(id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  n INTEGER NOT NULL, criado_em TEXT NOT NULL, UNIQUE(campaign_id, n));
CREATE TABLE winners(campaign_id BIGINT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE, user_id BIGINT NOT NULL, n INTEGER NOT NULL, total INTEGER NOT NULL, data TEXT NOT NULL,
  metodo TEXT, snapshot_hash TEXT, seed_revelada TEXT, sorteado_em TEXT, entregue_em TEXT, entregue_por BIGINT);
CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE pedidos(id BIGSERIAL PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES users(id), campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  numeros TEXT NOT NULL, total_centavos INTEGER NOT NULL CHECK(total_centavos > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PAID','EXPIRED','CANCELED','FAILED','REFUND_NEEDED','REFUNDED')),
  mp_order_id TEXT UNIQUE, mp_status TEXT, qr_code TEXT, qr_code_base64 TEXT, ticket_url TEXT,
  expira_em BIGINT NOT NULL, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL, pago_em TEXT);
CREATE TABLE reservas(campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, n INTEGER NOT NULL,
  pedido_id BIGINT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE, PRIMARY KEY(campaign_id, n));
CREATE INDEX ix_tickets_user ON tickets(user_id);
CREATE INDEX ix_tickets_camp ON tickets(campaign_id, n);
CREATE INDEX ix_sessions_user ON sessions(user_id);
CREATE INDEX ix_tokens_user ON tokens_email(user_id, tipo);
CREATE INDEX ix_notif_user ON notifications(user_id, lida);
CREATE INDEX ix_audit_user ON audit_logs(user_id);
CREATE INDEX ix_camp_status ON campaigns(status);
CREATE INDEX ix_pedidos_user ON pedidos(user_id, id);
CREATE INDEX ix_pedidos_status ON pedidos(status, expira_em);
CREATE INDEX ix_pedidos_camp ON pedidos(campaign_id);
CREATE INDEX ix_reservas_pedido ON reservas(pedido_id);`
,
/* 2: restrições extras (defesa em profundidade) e índices. As CHECK entram como NOT VALID: valem para toda linha nova/alterada sem
      reescrever nem barrar dados antigos. Depois de conferir os dados, dá para rodar ALTER TABLE ... VALIDATE CONSTRAINT <nome>. */ `
ALTER TABLE users ADD CONSTRAINT ck_users_role CHECK (role IN ('USER','ADMIN','SUPER_ADMIN')) NOT VALID;
ALTER TABLE users ADD CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')) NOT VALID;
ALTER TABLE campaigns ADD CONSTRAINT ck_camp_status CHECK (status IN ('OPEN','CLOSED','DRAWN')) NOT VALID;
ALTER TABLE campaigns ADD CONSTRAINT ck_camp_max CHECK (max BETWEEN 1 AND 100 AND max_por_usuario BETWEEN 1 AND max) NOT VALID;
ALTER TABLE tickets ADD CONSTRAINT ck_tickets_n CHECK (n BETWEEN 1 AND 100) NOT VALID;
ALTER TABLE reservas ADD CONSTRAINT ck_reservas_n CHECK (n BETWEEN 1 AND 100) NOT VALID;
CREATE INDEX IF NOT EXISTS ix_tickets_camp_user ON tickets(campaign_id, user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expira ON sessions(expira);
CREATE INDEX IF NOT EXISTS ix_tokens_expira ON tokens_email(expira);
CREATE INDEX IF NOT EXISTS ix_audit_quando ON audit_logs(id DESC);
CREATE INDEX IF NOT EXISTS ix_pedidos_pending ON pedidos(expira_em) WHERE status='PENDING';`,
/* 3: arquivo reversível de campanhas, sem excluir pedidos ou participantes. */ `
ALTER TABLE campaigns ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
CREATE INDEX IF NOT EXISTS ix_camp_archived ON campaigns(archived, status);`
/* próximas alterações: acrescente novos itens a este array (nunca edite os já aplicados) */
];

async function migrar() {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(" + LOCK_MIGRACAO + ")"); // duas instâncias subindo juntas não migram ao mesmo tempo
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations(versao INTEGER PRIMARY KEY, aplicada_em TEXT NOT NULL)");
    const feitas = new Set((await c.query("SELECT versao FROM schema_migrations")).rows.map(r => r.versao));
    for (let i = 0; i < MIGRACOES.length; i++) {
      if (feitas.has(i + 1)) continue;
      await c.query("BEGIN");
      try { await c.query(MIGRACOES[i]); await c.query("INSERT INTO schema_migrations(versao, aplicada_em) VALUES($1,$2)", [i + 1, agora()]); await c.query("COMMIT"); }
      catch (e) { await c.query("ROLLBACK"); throw e; }
    }
  } finally { try { await c.query("SELECT pg_advisory_unlock(" + LOCK_MIGRACAO + ")"); } catch (_) { /* a conexão é devolvida de qualquer jeito */ } c.release(); }
}

/* Sorteios sem semente (ex.: importados de bancos antigos) ganham uma (compromisso = sha256 da semente) */
function novaSemente() { const s = crypto.randomBytes(32).toString("hex"); return { seed: s, commit: sha(s) }; }
async function semear() {
  for (const c of await all("SELECT id FROM campaigns WHERE seed IS NULL")) {
    const s = novaSemente(); await run("UPDATE campaigns SET seed=?, commit_hash=? WHERE id=?", [s.seed, s.commit, c.id]);
  }
}

/* Chame uma vez ao iniciar (servidor, scripts): cria/atualiza as tabelas. */
let pronto = null;
const iniciar = () => pronto || (pronto = (async () => { await migrar(); await semear(); })());
const fechar = () => pool.end();

async function audit(uid, acao, detalhe, ip) {
  await run("INSERT INTO audit_logs(quando,user_id,acao,detalhe,ip) VALUES(?,?,?,?,?)", [agora(), uid || null, acao, detalhe ? String(detalhe).slice(0, 300) : null, ip || null]);
}
async function notificar(uid, titulo, texto) {
  await run("INSERT INTO notifications(user_id,titulo,texto,criado_em) VALUES(?,?,?,?)", [uid, titulo, texto, agora()]);
}
/* Versão barata para rotas de leitura: só entra na transação (e na trava de escrita) quando existe mesmo algo vencido.
   Antes, TODA chamada a /api/estado e /api/pedidos disputava a trava global de escrita. */
async function liberarSeVencido() {
  if (await get("SELECT 1 FROM pedidos WHERE status='PENDING' AND mp_order_id IS NULL AND expira_em<? LIMIT 1", [Date.now()])) await tx(() => liberar());
}
const ping = () => get("SELECT 1 ok");
/* Libera reservas de pedidos vencidos. Chamar DENTRO de uma transação (ou via tx(() => liberar())). */
async function liberar() {
  await run("UPDATE pedidos SET status='EXPIRED', atualizado_em=? WHERE status='PENDING' AND mp_order_id IS NULL AND expira_em<?", [agora(), Date.now()]);
  await run("DELETE FROM reservas WHERE pedido_id IN (SELECT id FROM pedidos WHERE status<>'PENDING')");
}
module.exports = { db, tx, iniciar, fechar, liberar, liberarSeVencido, ping, sha, agora, audit, notificar, novaSemente };
