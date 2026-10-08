/* Utilidades: erros, validação de entrada, limite de tentativas, cookies. */
const cfg = require("./config");
class Erro extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const RE = { email: /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/, hex: /^#[0-9a-f]{6}$/i, data: /^\d{4}-\d{2}-\d{2}$/ };
const JPG = "data:image/jpeg;base64,";

const txt = (v, max, min = 0) => {
  if (typeof v !== "string") throw new Erro("Campo inválido.");
  const t = v.trim(); if (t.length < min || t.length > max) throw new Erro("Campo inválido."); return t;
};
/* Só aceita número inteiro de verdade ou texto de dígitos ("7"). Antes, Number() deixava passar "1e2", "0x10", true e [5]. */
const inteiro = (v, min, max, msg) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d{1,15}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Erro(msg || "Número inválido."); return n;
};
const foto = (v, max) => { if (v === "") return ""; if (typeof v !== "string" || !v.startsWith(JPG) || v.length > max || !/^[A-Za-z0-9+/]+=*$/.test(v.slice(JPG.length))) throw new Erro("Imagem inválida ou grande demais."); return v; };
const abrev = n => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? p[0] + " " + p[p.length - 1][0] + "." : p[0]; }; // privacidade (LGPD)

const baldes = new Map(); // chave -> { ts: [instantes], janela }
function limite(chave, max, janelaMs) { // limitador em memória (para vários servidores, troque por Redis ou banco)
  if (cfg.TESTE) return;
  const agora = Date.now(), b = baldes.get(chave) || { ts: [], janela: janelaMs };
  b.janela = Math.max(b.janela, janelaMs); b.ts = b.ts.filter(t => agora - t < janelaMs); b.ts.push(agora); baldes.set(chave, b);
  if (b.ts.length > max) throw new Erro("Muitas tentativas. Aguarde alguns minutos.", 429);
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
  if (xff) { const l = String(xff).split(",").map(s => s.trim()).filter(Boolean); if (l.length) return l[Math.max(0, l.length - cfg.TRUST_PROXY_HOPS)]; }
  return req.socket.remoteAddress;
}
module.exports = { Erro, RE, txt, inteiro, foto, abrev, limite, cookie, ipDe, _baldes };
