/* Utilidades: erros, validação de entrada, limite de tentativas, cookies. */
const cfg = require("./config");
class Erro extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const RE = { email: /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/, hex: /^#[0-9a-f]{6}$/i, data: /^\d{4}-\d{2}-\d{2}$/ };
const JPG = "data:image/jpeg;base64,", WEBP = "data:image/webp;base64,";

const txt = (v, max, min = 0) => {
  if (typeof v !== "string") throw new Erro("Campo inválido.");
  const t = v.trim(); if (t.length < min || t.length > max) throw new Erro("Campo inválido."); return t;
};
/* Só aceita número inteiro de verdade ou texto de dígitos ("7"). Antes, Number() deixava passar "1e2", "0x10", true e [5]. */
const inteiro = (v, min, max, msg) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d{1,15}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Erro(msg || "Número inválido."); return n;
};
/* Fotos: JPEG (sem transparência) ou WebP (aceita fundo transparente nas skins). O WebP precisa ter a assinatura
   RIFF....WEBP de verdade; o tipo servido vem do prefixo validado aqui, nunca do navegador. */
const foto = (v, max) => {
  if (v === "") return "";
  const prefixo = typeof v === "string" ? [JPG, WEBP].find(p => v.startsWith(p)) : null;
  if (!prefixo || v.length > max || !/^[A-Za-z0-9+/]+=*$/.test(v.slice(prefixo.length))) throw new Erro("Imagem inválida ou grande demais.");
  if (prefixo === WEBP) { const b = Buffer.from(v.slice(WEBP.length, WEBP.length + 16), "base64"); if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") throw new Erro("Imagem inválida ou grande demais."); }
  return v;
};
const abrev = n => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? p[0] + " " + p[p.length - 1][0] + "." : p[0]; }; // privacidade (LGPD)

const baldes = new Map(); // chave -> { ts: [instantes], janela }
const MAX_BALDES = 20000;
function limite(chave, max, janelaMs) { // limitador em memória (para vários servidores, troque por Redis ou banco)
  if (cfg.TESTE) return;
  const agora = Date.now();
  let b = baldes.get(chave);
  // Reinserir a cada uso deixa o Map em ordem de uso recente (o primeiro é o menos usado).
  if (b) baldes.delete(chave);
  else {
    b = { ts: [], janela: janelaMs };
    // Cheio: descarta o balde usado há mais tempo. Antes, todo cliente novo recebia 429 em toda a API
    // até as chaves expirarem, e anônimos conseguiam encher o mapa.
    while (baldes.size >= MAX_BALDES) baldes.delete(baldes.keys().next().value);
  }
  b.janela = Math.max(b.janela, janelaMs); b.ts = b.ts.filter(t => agora - t < janelaMs);
  if (b.ts.length >= max) { baldes.set(chave, b); throw new Erro("Muitas tentativas. Aguarde alguns minutos.", 429); }
  b.ts.push(agora); baldes.set(chave, b);
}
/* Poda só o que já expirou. (Antes o mapa inteiro era zerado a cada hora: quem estava bloqueado voltava a ter tentativas de graça.) */
setInterval(() => { const t = Date.now(); for (const [k, b] of baldes) if (!b.ts.length || t - b.ts[b.ts.length - 1] > b.janela) baldes.delete(k); }, 6e4).unref();
const _baldes = baldes; // só para testes

function cookie(req, nome) {
  const m = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(nome + "="));
  return m ? m.slice(nome.length + 1) : null;
}
/* Atrás de proxy confiável, o IP do cliente é o que o PRIMEIRO proxy confiável anexou: contamos TRUST_PROXY_HOPS entradas a partir da direita
   (1 = Caddy/Nginx sozinho; no Render pode ser 2 se houver outra camada na frente: confira em Admin > Logs se os IPs variam entre pessoas).
   Entradas mais à esquerda são forjáveis pelo cliente e nunca são usadas. */
function ipDe(req) {
  const xff = cfg.TRUST_PROXY && req.headers["x-forwarded-for"];
  if (xff) { const l = String(xff).split(",").map(s => s.trim()).filter(Boolean); if (l.length >= cfg.TRUST_PROXY_HOPS) { const ip = l[l.length - cfg.TRUST_PROXY_HOPS]; if (require("node:net").isIP(ip)) return ip; } }
  return req.socket.remoteAddress;
}
/* Chave de cliente para os LIMITES (não para a auditoria, que guarda o IP inteiro).
   Um único cliente IPv6 costuma receber um /64 inteiro: contar cada endereço separado dava a ele
   2^64 cotas. Formas textuais diferentes do mesmo endereço ("::ffff:1.2.3.4", zeros à esquerda,
   maiúsculas, "::") também viravam chaves diferentes. */
function chaveIp(ip) {
  let s = String(ip == null ? "" : ip).trim().toLowerCase();
  const pct = s.indexOf("%"); if (pct >= 0) s = s.slice(0, pct);          // zona (fe80::1%eth0)
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const net = require("node:net");
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return s;
  let [esq, dir = null] = s.split("::");
  const partes = t => t ? t.split(":") : [];
  let a = partes(esq), b = dir === null ? [] : partes(dir);
  const v4 = x => { const u = x[x.length - 1]; if (u && net.isIPv4(u)) { const o = u.split(".").map(Number); x.splice(x.length - 1, 1, ((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)); } };
  if (dir === null) v4(a); else v4(b);
  const grupos = dir === null ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  const h = grupos.map(g => parseInt(g, 16));
  // ::ffff:a.b.c.d (IPv4 mapeado) é o mesmo cliente que a.b.c.d
  if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) return [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join(".");
  return h.slice(0, 4).map(x => x.toString(16)).join(":") + "::/64";
}
module.exports = { Erro, RE, txt, inteiro, foto, JPG, WEBP, abrev, limite, cookie, ipDe, chaveIp, _baldes, MAX_BALDES };
