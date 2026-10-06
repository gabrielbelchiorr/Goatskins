/* Banco SQLite + migrações versionadas (PRAGMA user_version). */
const { DatabaseSync } = require("node:sqlite"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const cfg = require("./config");
fs.mkdirSync(path.dirname(cfg.DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(cfg.DATABASE_PATH);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const agora = () => new Date().toISOString();
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const MIGRACOES = [
/* 1: estrutura original do projeto */ `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, nome TEXT NOT NULL, contato TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expira INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY, premio TEXT NOT NULL, desgaste TEXT NOT NULL DEFAULT '', valor REAL NOT NULL DEFAULT 0, cor TEXT NOT NULL DEFAULT '#b3263a', fim TEXT NOT NULL, max INTEGER NOT NULL, foto TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, n INTEGER NOT NULL, UNIQUE(campaign_id, user_id), UNIQUE(campaign_id, n));
CREATE TABLE IF NOT EXISTS winners(campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, n INTEGER NOT NULL, total INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
/* 2: contas completas, papéis, auditoria, notificações, sorteio verificável, índices */ `
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN telefone TEXT;
ALTER TABLE users ADD COLUMN email_verificado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE users ADD COLUMN falhas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN bloqueado_ate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN consentimento_em TEXT;
ALTER TABLE users ADD COLUMN criado_em TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN atualizado_em TEXT NOT NULL DEFAULT '';
UPDATE users SET role = CASE role WHEN 'admin' THEN 'SUPER_ADMIN' ELSE 'USER' END,
  criado_em = ${NOW}, atualizado_em = ${NOW}, email = CASE WHEN contato LIKE '%@%' THEN contato END;
CREATE UNIQUE INDEX ux_users_email ON users(email) WHERE email IS NOT NULL;
CREATE TABLE tokens_email(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, tipo TEXT NOT NULL, expira INTEGER NOT NULL, usado INTEGER NOT NULL DEFAULT 0);
CREATE TABLE audit_logs(id INTEGER PRIMARY KEY, quando TEXT NOT NULL, user_id INTEGER, acao TEXT NOT NULL, detalhe TEXT, ip TEXT);
CREATE TABLE notifications(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, titulo TEXT NOT NULL, texto TEXT NOT NULL, lida INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL);
ALTER TABLE campaigns ADD COLUMN descricao TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN status TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE campaigns ADD COLUMN max_por_usuario INTEGER NOT NULL DEFAULT 1;
ALTER TABLE campaigns ADD COLUMN seed TEXT;
ALTER TABLE campaigns ADD COLUMN commit_hash TEXT;
ALTER TABLE campaigns ADD COLUMN criado_por INTEGER;
ALTER TABLE campaigns ADD COLUMN criado_em TEXT NOT NULL DEFAULT '';
UPDATE campaigns SET criado_em = ${NOW}, status = CASE WHEN EXISTS(SELECT 1 FROM winners w WHERE w.campaign_id = campaigns.id) THEN 'DRAWN' ELSE 'OPEN' END;
CREATE TABLE tickets_novo(id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, n INTEGER NOT NULL, criado_em TEXT NOT NULL, UNIQUE(campaign_id, n));
INSERT INTO tickets_novo(id, campaign_id, user_id, n, criado_em) SELECT id, campaign_id, user_id, n, ${NOW} FROM tickets;
DROP TABLE tickets;
ALTER TABLE tickets_novo RENAME TO tickets;
ALTER TABLE winners ADD COLUMN metodo TEXT;
ALTER TABLE winners ADD COLUMN snapshot_hash TEXT;
ALTER TABLE winners ADD COLUMN seed_revelada TEXT;
ALTER TABLE winners ADD COLUMN sorteado_em TEXT;
CREATE INDEX ix_tickets_user ON tickets(user_id);
CREATE INDEX ix_tickets_camp ON tickets(campaign_id, n);
CREATE INDEX ix_sessions_user ON sessions(user_id);
CREATE INDEX ix_tokens_user ON tokens_email(user_id, tipo);
CREATE INDEX ix_notif_user ON notifications(user_id, lida);
CREATE INDEX ix_audit_user ON audit_logs(user_id);
CREATE INDEX ix_camp_status ON campaigns(status);`,
/* 3: novo título e subtítulo padrão (só troca se ainda forem os textos antigos) */ `
UPDATE settings SET v = json_set(v, '$.titulo', 'GOATSKINS SORTEIOS') WHERE k='visual' AND json_extract(v, '$.titulo') = 'Sorteios de skins';
UPDATE settings SET v = json_set(v, '$.sub', 'Escolha seus números e concorra a skins de CS.') WHERE k='visual' AND json_extract(v, '$.sub') LIKE '%gratuita%';`
,
/* 4: pagamentos (Mercado Pago/Pix): preço por número, pedidos, reservas com expiração, entrega do prêmio */ `
ALTER TABLE campaigns ADD COLUMN preco_centavos INTEGER NOT NULL DEFAULT 0 CHECK(preco_centavos >= 0);
CREATE TABLE pedidos(id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id), campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  numeros TEXT NOT NULL, total_centavos INTEGER NOT NULL CHECK(total_centavos > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PAID','EXPIRED','CANCELED','FAILED','REFUND_NEEDED','REFUNDED')),
  mp_order_id TEXT UNIQUE, mp_status TEXT, qr_code TEXT, qr_code_base64 TEXT, ticket_url TEXT,
  expira_em INTEGER NOT NULL, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL, pago_em TEXT);
CREATE INDEX ix_pedidos_user ON pedidos(user_id, id);
CREATE INDEX ix_pedidos_status ON pedidos(status, expira_em);
CREATE INDEX ix_pedidos_camp ON pedidos(campaign_id);
CREATE TABLE reservas(campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, n INTEGER NOT NULL,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE, PRIMARY KEY(campaign_id, n));
CREATE INDEX ix_reservas_pedido ON reservas(pedido_id);
ALTER TABLE winners ADD COLUMN entregue_em TEXT;
ALTER TABLE winners ADD COLUMN entregue_por INTEGER;`
];

(function migrar() {
  let v = db.prepare("PRAGMA user_version").get().user_version;
  for (; v < MIGRACOES.length; v++) {
    db.exec("BEGIN");
    try { db.exec(MIGRACOES[v]); db.exec("PRAGMA user_version=" + (v + 1)); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
})();

/* Sorteios antigos sem semente ganham uma (compromisso = sha256 da semente) */
function novaSemente() { const s = crypto.randomBytes(32).toString("hex"); return { seed: s, commit: sha(s) }; }
db.prepare("SELECT id FROM campaigns WHERE seed IS NULL").all().forEach(c => {
  const s = novaSemente(); db.prepare("UPDATE campaigns SET seed=?, commit_hash=? WHERE id=?").run(s.seed, s.commit, c.id);
});

/* Transação que bloqueia escrita logo no início (evita corridas) */
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch (_) { /* já revertido */ } throw e; }
}
function audit(uid, acao, detalhe, ip) {
  db.prepare("INSERT INTO audit_logs(quando,user_id,acao,detalhe,ip) VALUES(?,?,?,?,?)").run(agora(), uid || null, acao, detalhe ? String(detalhe).slice(0, 300) : null, ip || null);
}
function notificar(uid, titulo, texto) {
  db.prepare("INSERT INTO notifications(user_id,titulo,texto,criado_em) VALUES(?,?,?,?)").run(uid, titulo, texto, agora());
}
/* Libera reservas de pedidos vencidos. Chamar DENTRO de uma transação (ou via tx(liberar)). */
function liberar() {
  db.prepare("UPDATE pedidos SET status='EXPIRED', atualizado_em=? WHERE status='PENDING' AND expira_em<?").run(agora(), Date.now());
  db.prepare("DELETE FROM reservas WHERE pedido_id IN (SELECT id FROM pedidos WHERE status<>'PENDING')").run();
}
module.exports = { liberar, db, sha, agora, tx, audit, notificar, novaSemente };
