/* Sorteios: listagem pública, escolha de números, sorteio verificável. */
const crypto = require("node:crypto");
const { db, sha, agora, tx, audit, notificar, novaSemente, liberar } = require("./db");
const { Erro, RE, txt, inteiro, foto, abrev, limite } = require("./http");
const mail = require("./mail"), mp = require("./mercadopago");

const PADRAO_VISUAL = { titulo: "GOATSKINS SORTEIOS", sub: "Escolha seus números e concorra a skins de CS.", banner: "",
  cores: { gold: "#d4aa55", copper: "#b8651f", slate: "#3d4556", navy: "#0e1a33" } };
const visual = () => { const r = db.prepare("SELECT v FROM settings WHERE k='visual'").get(); return r ? JSON.parse(r.v) : PADRAO_VISUAL; };

/* Colunas públicas explícitas: a semente do sorteio NUNCA sai daqui antes da hora. */
const COLS = "id, premio, desgaste, descricao, valor, cor, fim, max, max_por_usuario, preco_centavos, length(foto) fl, status, commit_hash"; // a foto sai por URL própria (cache), não dentro do JSON
function estado(u) {
  tx(liberar);
  const ocup = {}, meus = {}, gan = {}, res = {};
  db.prepare("SELECT r.campaign_id c, r.n FROM reservas r JOIN pedidos p ON p.id=r.pedido_id WHERE p.status='PENDING' ORDER BY r.n").all().forEach(r => (res[r.c] = res[r.c] || []).push(r.n));
  db.prepare("SELECT campaign_id c, n FROM tickets ORDER BY n").all().forEach(r => (ocup[r.c] = ocup[r.c] || []).push(r.n));
  if (u) db.prepare("SELECT campaign_id c, n FROM tickets WHERE user_id=? ORDER BY n").all(u.id).forEach(r => (meus[r.c] = meus[r.c] || []).push(r.n));
  db.prepare("SELECT w.campaign_id, w.n, w.data, w.total, w.user_id, us.nome FROM winners w JOIN users us ON us.id=w.user_id").all().forEach(r => gan[r.campaign_id] = r);
  const nao = u ? db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND lida=0").get(u.id).n : 0;
  const vis = visual(); vis.banner = vis.banner ? "/api/banner?v=" + vis.banner.length : "";
  return { eu: u, naoLidas: nao, pix: mp.configurado(), s: vis, c: db.prepare("SELECT " + COLS + " FROM campaigns ORDER BY id").all().map(c => ({
    ...c, foto: c.fl ? "/api/campanhas/" + c.id + "/foto?v=" + c.fl : "", fl: undefined, preco: c.preco_centavos / 100, preco_centavos: undefined, reservados: res[c.id] || [], ocupados: ocup[c.id] || [], total: (ocup[c.id] || []).length, meus: meus[c.id] || [],
    ganhador: gan[c.id] ? { n: gan[c.id].n, nome: abrev(gan[c.id].nome), data: gan[c.id].data, total: gan[c.id].total, eu: !!u && gan[c.id].user_id === u.id } : null })) };
}

function corpoCampanha(b, editar) {
  const max = inteiro(b.max, 1, 100, "Vagas: de 1 a 100.");
  const d = { premio: txt(b.premio, 80, 1), desgaste: txt(b.desgaste || "", 40), descricao: txt(b.descricao || "", 500),
    valor: Number(b.valor) || 0, cor: RE.hex.test(b.cor) ? b.cor : "#b3263a", max,
    max_por_usuario: inteiro(b.max_por_usuario || 1, 1, max, "Limite por pessoa inválido."),
    fim: "" }; // sorteios não têm prazo: acontecem quando todos os números são escolhidos
  if (d.valor < 0 || d.valor > 1e7) throw new Erro("Valor inválido.");
  const preco = Math.round((Number(b.preco_numero) || 0) * 100); // preço por número, em centavos (inteiro: sem erro de ponto flutuante)
  if (!Number.isFinite(preco) || preco < 0 || preco > 1e6 || (preco > 0 && preco < 100)) throw new Erro("Preço por número: 0 (grátis) ou de R$ 1,00 a R$ 10.000,00.");
  d.preco_centavos = preco;
  d.foto = b.foto === undefined && editar ? undefined : foto(b.foto || "", 1.5e6);
  return d;
}

/* Prova do sorteio: vencedor = números[ HMAC-SHA256(semente, sha256(números)) mod N ] */
function calcularVencedor(seed, numeros) {
  const snapshot = sha(numeros.join(","));
  const h = crypto.createHmac("sha256", seed).update(snapshot).digest("hex");
  return { snapshot, n: numeros[Number(BigInt("0x" + h) % BigInt(numeros.length))] };
}

function sortear(id, adminId, ip) {
  const r = tx(() => {
    const c = db.prepare("SELECT * FROM campaigns WHERE id=?").get(id); if (!c) throw new Erro("Sorteio não encontrado.", 404);
    if (c.status === "DRAWN") throw new Erro("Este sorteio já foi realizado.");
    liberar(); if (db.prepare("SELECT COUNT(*) n FROM reservas WHERE campaign_id=?").get(id).n) throw new Erro("Há pagamentos Pix pendentes neste sorteio. Aguarde serem confirmados ou expirarem.");
    const nums = db.prepare("SELECT n FROM tickets WHERE campaign_id=? ORDER BY n").all(id).map(x => x.n);
    if (!nums.length) throw new Erro("Ninguém participou deste sorteio.");
    if (nums.length < c.max && c.status !== "CLOSED") throw new Erro("O sorteio só pode ser feito com 100% das vagas preenchidas ou depois de encerrar as inscrições.");
    const v = calcularVencedor(c.seed, nums);
    const t = db.prepare("SELECT user_id FROM tickets WHERE campaign_id=? AND n=?").get(id, v.n);
    db.prepare("INSERT INTO winners(campaign_id,user_id,n,total,data,metodo,snapshot_hash,seed_revelada,sorteado_em) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, t.user_id, v.n, nums.length, agora().slice(0, 10), "HMAC-SHA256(semente, sha256(numeros)) mod N", v.snapshot, c.seed, agora());
    db.prepare("UPDATE campaigns SET status='DRAWN' WHERE id=?").run(id);
    audit(adminId, "SORTEIO", "campanha " + id + " número " + v.n + " de " + nums.length, ip);
    db.prepare("SELECT DISTINCT user_id FROM tickets WHERE campaign_id=?").all(id).forEach(p =>
      notificar(p.user_id, "Sorteio realizado: " + c.premio, p.user_id === t.user_id ? "Parabéns! O seu número " + v.n + " foi o sorteado!" : "O sorteio foi realizado. Veja o resultado e a prova no Histórico."));
    return { n: v.n, total: nums.length, premio: c.premio, user_id: t.user_id };
  });
  const g = db.prepare("SELECT nome, email FROM users WHERE id=?").get(r.user_id);
  if (g.email) mail.enviar(g.email, "Você ganhou: " + r.premio + "!", "Parabéns, " + g.nome + "! O seu número " + r.n + " foi sorteado em " + r.premio + ". Entraremos em contato.");
  return { n: r.n, total: r.total, nome: abrev(g.nome) };
}

function imagem(dataUri) { // data:image/jpeg;base64,... -> bytes, com cache de 1 dia
  if (!dataUri) throw new Erro("Imagem não encontrada.", 404);
  return { raw: Buffer.from(dataUri.slice(23), "base64"), tipo: "image/jpeg" };
}

const rotas = [
  ["GET", /^\/api\/estado$/, ctx => estado(ctx.user)],
  ["POST", /^\/api\/campanhas\/(\d+)\/numeros$/, ctx => {
    const u = ctx.user, id = Number(ctx.params[0]); limite("claim:" + u.id, 30, 6e4);
    if (!u.email_verificado) throw new Erro("Confirme seu e-mail para participar.", 403);
    const nums = ctx.body.numeros;
    if (!Array.isArray(nums) || !nums.length || nums.length > 100) throw new Erro("Escolha pelo menos um número.");
    const lista = [...new Set(nums.map(n => inteiro(n, 1, 100)))];
    return tx(() => {
      const c = db.prepare("SELECT * FROM campaigns WHERE id=?").get(id); if (!c) throw new Erro("Sorteio não encontrado.", 404);
      if (c.status !== "OPEN") throw new Erro("Este sorteio não está aberto.");
      if (c.preco_centavos > 0) throw new Erro("Este sorteio exige pagamento por Pix.", 402); // impede "comprar" de graça por esta rota
      if (lista.some(n => n > c.max)) throw new Erro("Número fora do sorteio.");
      const meus = db.prepare("SELECT COUNT(*) n FROM tickets WHERE campaign_id=? AND user_id=?").get(id, u.id).n;
      if (meus + lista.length > c.max_por_usuario) throw new Erro("Limite de " + c.max_por_usuario + " número(s) por pessoa neste sorteio.");
      for (const n of lista) { // a regra UNIQUE(campaign_id, n) do banco é a garantia final contra número repetido
        try { db.prepare("INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES(?,?,?,?)").run(id, u.id, n, agora()); }
        catch (e) { if (/UNIQUE/i.test(e.message)) throw new Erro("O número " + n + " já foi escolhido por outra pessoa."); throw e; }
      }
      audit(u.id, "NUMEROS_ESCOLHIDOS", "campanha " + id + ": " + lista.join(","), ctx.ip);
      notificar(u.id, "Participação confirmada", "Seus números em " + c.premio + ": " + lista.join(", "));
      return { numeros: lista, completo: db.prepare("SELECT COUNT(*) n FROM tickets WHERE campaign_id=?").get(id).n >= c.max };
    });
  }, "user"],
  ["GET", /^\/api\/campanhas\/(\d+)\/foto$/, ctx => imagem((db.prepare("SELECT foto f FROM campaigns WHERE id=?").get(Number(ctx.params[0])) || {}).f)],
  ["GET", /^\/api\/banner$/, () => imagem(visual().banner)],
  ["GET", /^\/api\/campanhas\/(\d+)\/verificacao$/, ctx => { // prova pública do sorteio
    const id = Number(ctx.params[0]), c = db.prepare("SELECT status, commit_hash FROM campaigns WHERE id=?").get(id);
    if (!c) throw new Erro("Sorteio não encontrado.", 404);
    const w = db.prepare("SELECT n, snapshot_hash, seed_revelada, metodo, sorteado_em FROM winners WHERE campaign_id=?").get(id);
    if (!w) return { status: c.status, commit_hash: c.commit_hash };
    return { status: c.status, commit_hash: c.commit_hash, seed: w.seed_revelada, snapshot_hash: w.snapshot_hash, metodo: w.metodo, sorteado_em: w.sorteado_em,
      numeros: db.prepare("SELECT n FROM tickets WHERE campaign_id=? ORDER BY n").all(id).map(x => x.n), vencedor: w.n };
  }]
];
module.exports = { rotas, corpoCampanha, sortear, calcularVencedor, novaSemente, visual, RE, txt, foto };
