/* Configuração por variáveis de ambiente (ou arquivo .env). Nunca coloque segredos no código. */
const fs = require("node:fs"), path = require("node:path");
const raiz = path.join(__dirname, "..");
try { // leitor simples de .env (sem biblioteca)
  for (const l of fs.readFileSync(path.join(raiz, ".env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, ""); // ignora comentário no fim da linha
  }
} catch (e) { /* sem .env: usa os padrões */ }
const e = process.env, PORT = Number(e.PORT) || 3000, DATA_DIR = e.DATA_DIR || path.join(raiz, "data");
const cfgProd = { PRODUCAO: e.NODE_ENV === "production", url: (e.APP_URL || "").replace(/\/$/, ""), driver: e.EMAIL_DRIVER || "console", dbUrl: e.DATABASE_URL || "" };
if (cfgProd.PRODUCAO) { // falha cedo: melhor não subir do que subir inseguro
  const erros = [];
  if (!/^https:\/\//.test(cfgProd.url)) erros.push("APP_URL precisa começar com https://");
  if (!/^postgres(ql)?:\/\//.test(cfgProd.dbUrl)) erros.push("DATABASE_URL ausente ou inválida (no Render, use a Internal Database URL do PostgreSQL)");
  if (cfgProd.driver === "console") erros.push("EMAIL_DRIVER=console grava links de login/senha em arquivo; use resend");
  if (e.MP_ACCESS_TOKEN && !e.MP_WEBHOOK_SECRET) erros.push("MP_WEBHOOK_SECRET ausente (sem ele não dá para validar o webhook)");
  if (cfgProd.driver === "resend" && !e.EMAIL_API_KEY) erros.push("EMAIL_API_KEY ausente");
  if (e.TRUST_PROXY !== "1") console.warn("[config] TRUST_PROXY=1 não está ligado: atrás do proxy do Render todos os usuários pareceriam ter o mesmo IP (limites de tentativa e logs ficam errados).");
  if (e.TESTE === "1") erros.push("TESTE=1 desliga o limite de tentativas; não use em produção");
  if (e.MP_TESTE_APRO === "1") erros.push("MP_TESTE_APRO=1 é só para testes locais; remova do ambiente de produção");
  if (erros.length) { console.error("Configuração de produção inválida:\n - " + erros.join("\n - ")); process.exit(1); }
}
module.exports = {
  raiz, PORT, DATA_DIR,
  APP_URL: (e.APP_URL || "http://localhost:" + PORT).replace(/\/$/, ""),
  // PostgreSQL. Em produção DATABASE_URL é obrigatória (validada acima). Em desenvolvimento há um padrão local.
  DATABASE_URL: e.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/goatskins",
  // SSL: a Internal URL do Render não usa SSL; a External URL (host *.render.com) usa. Force com DATABASE_SSL=1 ou desligue com DATABASE_SSL=0.
  DATABASE_SSL: e.DATABASE_SSL === "1" || (e.DATABASE_SSL !== "0" && /\.render\.com/i.test(e.DATABASE_URL || "")),
  PG_POOL_MAX: Math.min(30, Math.max(2, Number(e.PG_POOL_MAX) || 10)),
  SQLITE_PATH: e.SQLITE_PATH || e.DATABASE_PATH || path.join(DATA_DIR, "goatskins.db"), // só usado por scripts/migrar-sqlite.js
  EMAIL_DRIVER: e.EMAIL_DRIVER || "console",   // "console" (grava em data/emails.log) ou "resend"
  EMAIL_API_KEY: e.EMAIL_API_KEY || "",
  EMAIL_FROM: e.EMAIL_FROM || "GOATSKINS <onboarding@resend.dev>",
  PRODUCAO: e.NODE_ENV === "production",
  TRUST_PROXY: e.TRUST_PROXY === "1",           // ligue só se houver proxy confiável (Caddy, Nginx)
  TRUST_PROXY_HOPS: Math.min(5, Math.max(1, Number(e.TRUST_PROXY_HOPS) || 1)), // quantos proxies confiáveis existem na frente (ver ipDe em http.js)
  TESTE: e.TESTE === "1",
  // Mercado Pago: segredos só no servidor (.env). Em produção a URL da API é fixa.
  MP_ACCESS_TOKEN: e.MP_ACCESS_TOKEN || "", MP_WEBHOOK_SECRET: e.MP_WEBHOOK_SECRET || "",
  MP_TESTE_APRO: e.NODE_ENV !== "production" && e.MP_TESTE_APRO === "1", // nunca vale em produção
  MP_API_BASE: e.NODE_ENV === "production" ? "https://api.mercadopago.com" : (e.MP_API_BASE || "https://api.mercadopago.com"),
  PIX_MINUTOS: Math.min(60 * 24, Math.max(30, Number(e.PIX_MINUTOS) || 30)), // o Pix tem mínimo de 30 min no Mercado Pago
  // Janela de checkout: 5 minutos. O Pix do MP continua com mínimo de 30; o servidor cancela a Order antes de liberar os números.
  RESERVA_MS: e.NODE_ENV !== "production" && Number(e.RESERVA_SEGUNDOS) > 0 ? Number(e.RESERVA_SEGUNDOS) * 1000 : 5 * 60e3
};