/* Painel administrativo: tudo aqui exige papel ADMIN ou SUPER_ADMIN, conferido no servidor. */
const { db, agora, audit, novaSemente } = require("./db");
const { Erro, RE, txt, foto, ipDe } = require("./http");
const { corpoCampanha, sortear, visual } = require("./rifas");

const rotas = [
  ["GET", /^\/api\/admin\/dashboard$/, () => {
    const um = sql => db.prepare(sql).get().n, hoje = agora().slice(0, 10), semana = new Date(Date.now() - 7 * 864e5).toISOString();
    return {
      usuarios: um("SELECT COUNT(*) n FROM users WHERE status!='DELETED'"), verificados: um("SELECT COUNT(*) n FROM users WHERE email_verificado=1 AND status='ACTIVE'"),
      sorteios: db.prepare("SELECT status, COUNT(*) n FROM campaigns GROUP BY status").all(),
      participacoes: um("SELECT COUNT(*) n FROM tickets"),
      hoje: db.prepare("SELECT COUNT(*) n FROM tickets WHERE criado_em>=?").get(hoje).n,
      semana: db.prepare("SELECT COUNT(*) n FROM tickets WHERE criado_em>=?").get(semana).n,
      porSorteio: db.prepare("SELECT c.id, c.premio, c.max, c.status, COUNT(t.id) escolhidos FROM campaigns c LEFT JOIN tickets t ON t.campaign_id=c.id GROUP BY c.id ORDER BY c.id DESC").all(),
      ultimas: db.prepare("SELECT t.n, t.criado_em, c.premio, u.nome, u.email FROM tickets t JOIN campaigns c ON c.id=t.campaign_id JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 10").all()
    };
  }, "admin"],
  ["GET", /^\/api\/admin\/usuarios$/, () => db.prepare("SELECT id, nome, email, role, status, email_verificado, criado_em FROM users ORDER BY id DESC LIMIT 200").all(), "admin"],
  ["PUT", /^\/api\/admin\/usuarios\/(\d+)\/status$/, ctx => {
    const id = Number(ctx.params[0]), st = ctx.body.status, alvo = db.prepare("SELECT role FROM users WHERE id=?").get(id);
    if (!alvo) throw new Erro("Usuário não encontrado.", 404);
    if (!["ACTIVE", "SUSPENDED"].includes(st)) throw new Erro("Status inválido.");
    if (id === ctx.user.id || alvo.role === "SUPER_ADMIN") throw new Erro("Você não pode alterar esta conta.", 403);
    if (alvo.role === "ADMIN" && ctx.user.role !== "SUPER_ADMIN") throw new Erro("Apenas o SUPER_ADMIN altera administradores.", 403);
    db.prepare("UPDATE users SET status=?, atualizado_em=? WHERE id=? AND status!='DELETED'").run(st, agora(), id);
    if (st === "SUSPENDED") db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    audit(ctx.user.id, "USUARIO_STATUS", "usuário " + id + " -> " + st, ctx.ip); return { ok: true };
  }, "admin"],
  ["PUT", /^\/api\/admin\/usuarios\/(\d+)\/papel$/, ctx => { // somente SUPER_ADMIN promove/rebaixa
    const id = Number(ctx.params[0]), papel = ctx.body.role, alvo = db.prepare("SELECT role FROM users WHERE id=?").get(id);
    if (!alvo) throw new Erro("Usuário não encontrado.", 404);
    if (!["USER", "ADMIN"].includes(papel)) throw new Erro("Papel inválido.");
    if (id === ctx.user.id || alvo.role === "SUPER_ADMIN") throw new Erro("Você não pode alterar esta conta.", 403);
    db.prepare("UPDATE users SET role=?, atualizado_em=? WHERE id=?").run(papel, agora(), id);
    audit(ctx.user.id, "USUARIO_PAPEL", "usuário " + id + " -> " + papel, ctx.ip); return { ok: true };
  }, "super"],
  ["GET", /^\/api\/admin\/logs$/, () => db.prepare("SELECT l.quando, l.acao, l.detalhe, l.ip, u.email FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 150").all(), "admin"],
  ["GET", /^\/api\/admin\/campanhas\/(\d+)\/participantes$/, ctx =>
    db.prepare("SELECT t.n, t.criado_em, u.nome, u.email FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.campaign_id=? ORDER BY t.n").all(Number(ctx.params[0])), "admin"],
  ["POST", /^\/api\/admin\/campanhas$/, ctx => {
    const d = corpoCampanha(ctx.body, false), s = novaSemente(); // o compromisso (hash da semente) já nasce público
    db.prepare("INSERT INTO campaigns(premio,desgaste,descricao,valor,cor,fim,max,max_por_usuario,foto,seed,commit_hash,criado_por,criado_em,preco_centavos) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(d.premio, d.desgaste, d.descricao, d.valor, d.cor, d.fim, d.max, d.max_por_usuario, d.foto, s.seed, s.commit, ctx.user.id, agora(), d.preco_centavos);
    audit(ctx.user.id, "SORTEIO_CRIADO", d.premio, ctx.ip); return { ok: true };
  }, "admin"],
  ["PUT", /^\/api\/admin\/campanhas\/(\d+)$/, ctx => {
    const id = Number(ctx.params[0]), d = corpoCampanha(ctx.body, true), ant = db.prepare("SELECT foto, status, preco_centavos FROM campaigns WHERE id=?").get(id);
    if (!ant) throw new Erro("Sorteio não encontrado.", 404);
    if (ant.status === "DRAWN") throw new Erro("Sorteio já realizado não pode ser editado.");
    const total = db.prepare("SELECT COUNT(*) n, COALESCE(MAX(n),0) m FROM tickets WHERE campaign_id=?").get(id);
    if (d.preco_centavos !== ant.preco_centavos && (total.n || db.prepare("SELECT COUNT(*) n FROM pedidos WHERE campaign_id=? AND status IN ('PENDING','PAID')").get(id).n))
      throw new Erro("Não é possível mudar o preço depois que há números vendidos ou pedidos em andamento.");
    if (d.max < total.m) throw new Erro("Já existem números escolhidos até o " + total.m + "; as vagas não podem ser menores.");
    db.prepare("UPDATE campaigns SET premio=?,desgaste=?,descricao=?,valor=?,cor=?,fim=?,max=?,max_por_usuario=?,foto=?,preco_centavos=? WHERE id=?")
      .run(d.premio, d.desgaste, d.descricao, d.valor, d.cor, d.fim, d.max, d.max_por_usuario, d.foto === undefined ? ant.foto : d.foto, d.preco_centavos, id);
    audit(ctx.user.id, "SORTEIO_EDITADO", "campanha " + id, ctx.ip); return { ok: true };
  }, "admin"],
  ["DELETE", /^\/api\/admin\/campanhas\/(\d+)$/, ctx => {
    const id = Number(ctx.params[0]), c = db.prepare("SELECT status FROM campaigns WHERE id=?").get(id);
    if (!c) throw new Erro("Sorteio não encontrado.", 404);
    if (c.status === "DRAWN") throw new Erro("Sorteio realizado fica guardado no histórico e não pode ser excluído.");
    if (db.prepare("SELECT (SELECT COUNT(*) FROM tickets WHERE campaign_id=?1) + (SELECT COUNT(*) FROM pedidos WHERE campaign_id=?1) n").get(id).n) throw new Erro("Este sorteio já tem participantes ou pedidos. Encerre-o em vez de excluir.");
    db.prepare("DELETE FROM campaigns WHERE id=?").run(id); audit(ctx.user.id, "SORTEIO_EXCLUIDO", "campanha " + id, ctx.ip); return { ok: true };
  }, "admin"],
  ["POST", /^\/api\/admin\/campanhas\/(\d+)\/encerrar$/, ctx => {
    const id = Number(ctx.params[0]), r = db.prepare("UPDATE campaigns SET status='CLOSED' WHERE id=? AND status='OPEN'").run(id);
    if (!r.changes) throw new Erro("Só é possível encerrar sorteios abertos."); audit(ctx.user.id, "SORTEIO_ENCERRADO", "campanha " + id, ctx.ip); return { ok: true };
  }, "admin"],
  ["POST", /^\/api\/admin\/campanhas\/(\d+)\/sortear$/, ctx => sortear(Number(ctx.params[0]), ctx.user.id, ctx.ip), "admin"],
  ["GET", /^\/api\/admin\/ganhadores$/, () => db.prepare("SELECT w.campaign_id id, c.premio, w.n, w.sorteado_em, w.entregue_em, u.nome, u.email, u.telefone FROM winners w JOIN campaigns c ON c.id=w.campaign_id JOIN users u ON u.id=w.user_id ORDER BY w.rowid DESC LIMIT 100").all(), "admin"],
  ["POST", /^\/api\/admin\/campanhas\/(\d+)\/entregar$/, ctx => {
    const id = Number(ctx.params[0]), r = db.prepare("UPDATE winners SET entregue_em=?, entregue_por=? WHERE campaign_id=? AND entregue_em IS NULL").run(agora(), ctx.user.id, id);
    if (!r.changes) throw new Erro("Sorteio sem ganhador ou já entregue."); audit(ctx.user.id, "PREMIO_ENTREGUE", "campanha " + id, ctx.ip); return { ok: true };
  }, "admin"],
  ["PUT", /^\/api\/admin\/visual$/, ctx => {
    const b = ctx.body, ant = visual(), cores = {};
    ["gold", "copper", "slate", "navy"].forEach(k => { if (!RE.hex.test(b.cores && b.cores[k])) throw new Erro("Cor inválida."); cores[k] = b.cores[k]; });
    const v = { titulo: txt(b.titulo, 80, 1), sub: txt(b.sub || "", 200), cores, banner: b.banner === undefined ? ant.banner : foto(b.banner, 3e6) };
    db.prepare("INSERT INTO settings VALUES('visual',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(v));
    audit(ctx.user.id, "VISUAL_ATUALIZADO", null, ctx.ip); return { ok: true };
  }, "admin"]
];
module.exports = { rotas };
