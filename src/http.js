/* Utilidades: erros, validação de entrada, limite de tentativas, cookies. */
const cfg = require("./config");
class Erro extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const RE = { email: /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/, hex: /^#[0-9a-f]{6}$/i, data: /^\d{4}-\d{2}-\d{2}$/ };
const JPG = "data:image/jpeg;base64,";

const txt = (v, max, min = 0) => {
  if (typeof v !== "string") throw new Erro("Campo inválido.");
  const t = v.trim(); if (t.length < min || t.length > max) throw new Erro("Campo inválido."); return t;
};
const inteiro = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Erro(msg || "Número inválido."); return n; };
const foto = (v, max) => { if (v === "") return ""; if (typeof v !== "string" || !v.startsWith(JPG) || v.length > max || !/^[A-Za-z0-9+/]+=*$/.test(v.slice(JPG.length))) throw new Erro("Imagem inválida ou grande demais."); return v; };
const abrev = n => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? p[0] + " " + p[p.length - 1][0] + "." : p[0]; }; // privacidade (LGPD)

const baldes = new Map();
function limite(chave, max, janelaMs) { // limitador em memória (para vários servidores, troque por Redis ou banco)
  if (cfg.TESTE) return;
  const a = (baldes.get(chave) || []).filter(t => Date.now() - t < janelaMs); a.push(Date.now()); baldes.set(chave, a);
  if (a.length > max) throw new Erro("Muitas tentativas. Aguarde alguns minutos.", 429);
}
setInterval(() => baldes.clear(), 36e5).unref();

function cookie(req, nome) {
  const m = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(nome + "="));
  return m ? m.slice(nome.length + 1) : null;
}
function ipDe(req) {
  if (cfg.TRUST_PROXY && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",").pop().trim();
  return req.socket.remoteAddress;
}
module.exports = { Erro, RE, txt, inteiro, foto, abrev, limite, cookie, ipDe };
