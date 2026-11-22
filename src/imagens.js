/* Fotos dos sorteios e banner: binário (BYTEA) na tabela "imagens", fora das linhas de campaigns/settings.
   Antes ficavam como texto base64 (33% maior) dentro dessas linhas; toda leitura do visual fazia parse do
   banner inteiro e cada edição de sorteio regravava a foto junto.
   Compatibilidade: a migração 15 copia as fotos antigas sem apagá-las. Se alguma não tiver sido copiada
   (dado malformado), a leitura cai na coluna antiga. Ao gravar uma foto nova, a cópia antiga é zerada,
   para não ressuscitar depois de uma remoção. */
const crypto = require("node:crypto");
const { db, agora } = require("./db");
const { JPG, WEBP } = require("./http");

const chaveCampanha = id => "campanha:" + Number(id);
const CHAVE_BANNER = "banner";

function decodificar(dataUri) {
  const webp = dataUri.startsWith(WEBP);
  return { tipo: webp ? "image/webp" : "image/jpeg", dados: Buffer.from(dataUri.slice((webp ? WEBP : JPG).length), "base64") };
}
/* dataUri já validado por http.foto(). "" remove a imagem. */
async function gravar(chave, dataUri) {
  if (!dataUri) { await db.run("DELETE FROM imagens WHERE chave=?", [chave]); return null; }
  const { tipo, dados } = decodificar(dataUri), versao = crypto.createHash("sha256").update(dados).digest("hex").slice(0, 16);
  await db.run(`INSERT INTO imagens(chave,tipo,dados,versao,atualizado_em) VALUES(?,?,?,?,?)
    ON CONFLICT(chave) DO UPDATE SET tipo=excluded.tipo, dados=excluded.dados, versao=excluded.versao, atualizado_em=excluded.atualizado_em`,
    [chave, tipo, dados, versao, agora()]);
  return versao;
}
/* { raw, tipo } ou null. legado(): carrega o data URI antigo, só usado se a cópia não existir. */
async function ler(chave, legado) {
  const r = await db.get("SELECT tipo, dados FROM imagens WHERE chave=?", [chave]);
  if (r) return { raw: r.dados, tipo: r.tipo };
  const antigo = legado ? await legado() : "";
  return antigo && (antigo.startsWith(JPG) || antigo.startsWith(WEBP)) ? (({ tipo, dados }) => ({ raw: dados, tipo }))(decodificar(antigo)) : null;
}
async function comoDataUri(chave, legado) {
  const img = await ler(chave, legado);
  return img ? (img.tipo === "image/webp" ? WEBP : JPG) + Buffer.from(img.raw).toString("base64") : "";
}
const legadoCampanha = id => async () => ((await db.get("SELECT foto FROM campaigns WHERE id=?", [id])) || {}).foto || "";
const legadoBanner = async () => ((await db.get("SELECT v::jsonb->>'banner' b FROM settings WHERE k='visual'")) || {}).b || "";

module.exports = { chaveCampanha, CHAVE_BANNER, gravar, ler, comoDataUri, legadoCampanha, legadoBanner, decodificar };
