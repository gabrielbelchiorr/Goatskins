/* Configuração por variáveis de ambiente (ou arquivo .env). Nunca coloque segredos no código. */
const fs = require("node:fs"), path = require("node:path");
const raiz = path.join(__dirname, "..");

try { // leitor simples de .env (sem biblioteca)
  for (const l of fs.readFileSync(path.join(raiz, ".env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2]
        .replace(/\s+#.*$/, "")
        .replace(/^["']|["']$/g, "");
    }
  }
} catch (e) { /* sem .env: usa os padrões */ }

const e = process.env;
const PORT = Number(e.PORT) || 3000;
const DATA_DIR = e.DATA_DIR || path.join(raiz, "data");

const cfgProd = {
  PRODUCAO: e.NODE_ENV === "production" || e.RENDER === "true",
  url: (e.APP_URL || "").replace(/\/$/, ""),
  driver: e.EMAIL_DRIVER || "console",
  dbUrl: e.DATABASE_URL || ""
};

if (!["console", "resend"].includes(cfgProd.driver)) {
  throw new Error("EMAIL_DRIVER inválido: use console ou resend");
}

if (cfgProd.PRODUCAO) {
  const erros = [];

  try {
    const url = new URL(cfgProd.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error();
    }
  } catch (_) {
    erros.push("APP_URL precisa ser uma origem https:// válida, sem caminho, senha ou parâmetros");
  }

  if (!/^postgres(ql)?:\/\//.test(cfgProd.dbUrl)) {
    erros.push("DATABASE_URL ausente ou inválida (no Render, use a Internal Database URL do PostgreSQL)");
  }

  if (cfgProd.driver !== "resend") {
    erros.push("EMAIL_DRIVER=console grava links de login/senha em arquivo; use resend");
  }

  if (e.MP_ACCESS_TOKEN && !e.MP_WEBHOOK_SECRET) {
    erros.push("MP_WEBHOOK_SECRET ausente (sem ele não dá para validar o webhook)");
  }

  if (cfgProd.driver === "resend" && !e.EMAIL_API_KEY) {
    erros.push("EMAIL_API_KEY ausente");
  }

  if (!/^[a-f0-9]{64,}$/i.test(e.EMAIL_CODE_SECRET || "")) {
    erros.push("EMAIL_CODE_SECRET precisa ter pelo menos 32 bytes aleatórios em hexadecimal");
  }

  if (
    !e.EMAIL_FROM ||
    /resend\.dev|seudominio|example\./i.test(e.EMAIL_FROM) ||
    !/^[^\r\n]+@[^\s<>]+\.[^\s<>]+>?$/.test(e.EMAIL_FROM)
  ) {
    erros.push("EMAIL_FROM precisa usar seu domínio verificado no Resend (não o remetente de teste)");
  }

  if (e.TRUST_PROXY !== "1") {
    console.warn("[config] TRUST_PROXY=1 não está ligado: atrás do proxy do Render todos os usuários pareceriam ter o mesmo IP (limites de tentativa e logs ficam errados).");
  }


  if (!e.TURNSTILE_SITE_KEY || !e.TURNSTILE_SECRET_KEY) {
    erros.push("Configure TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY em produção");
  }

  if (
    [e.TURNSTILE_SITE_KEY, e.TURNSTILE_SECRET_KEY].some(
      chave => /^[123]x00000000000000000000/.test(chave || "")
    )
  ) {
    erros.push("Chave de teste Turnstile não permitida em produção");
  }

  if (e.TESTE === "1") {
    erros.push("TESTE=1 desliga o limite de tentativas; não use em produção");
  }

  if (e.ORIGIN_VERIFY_SECRET && e.ORIGIN_VERIFY_SECRET.length < 32) {
    erros.push("ORIGIN_VERIFY_SECRET precisa ter pelo menos 32 caracteres quando configurado");
  }

  if (e.MP_TESTE_APRO === "1") {
    erros.push("MP_TESTE_APRO=1 é só para testes locais; remova do ambiente de produção");
  }

  if (erros.length) {
    console.error("Configuração de produção inválida:\n - " + erros.join("\n - "));
    process.exit(1);
  }
}

module.exports = {
  raiz,
  PORT,
  DATA_DIR,

  TURNSTILE_SITE_KEY: e.TURNSTILE_SITE_KEY || "",
  TURNSTILE_SECRET_KEY: e.TURNSTILE_SECRET_KEY || "",

  // Domínios adicionais sob seu controle. APP_URL continua sendo o domínio canônico.
  TURNSTILE_HOSTNAMES: e.TURNSTILE_HOSTNAMES || "",

  DATABASE_CA: e.DATABASE_CA || "",
  APP_URL: (e.APP_URL || "http://localhost:" + PORT).replace(/\/$/, ""),

  // PostgreSQL. Em produção DATABASE_URL é obrigatória.
  DATABASE_URL: e.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/goatskins",

  // Force SSL com DATABASE_SSL=1 ou desligue com DATABASE_SSL=0.
  DATABASE_SSL: e.DATABASE_SSL === "1" ||
    (e.DATABASE_SSL !== "0" && /\.render\.com/i.test(e.DATABASE_URL || "")),

  PG_POOL_MAX: Math.min(30, Math.max(1, Number(e.PG_POOL_MAX) || 10)),

  // Só usado por scripts/migrar-sqlite.js.
  SQLITE_PATH: e.SQLITE_PATH || e.DATABASE_PATH || path.join(DATA_DIR, "goatskins.db"),

  EMAIL_DRIVER: e.EMAIL_DRIVER || "console",
  EMAIL_CODE_SECRET: e.EMAIL_CODE_SECRET ||
    (cfgProd.PRODUCAO ? "" : "somente-desenvolvimento-nao-usar-em-producao"),
  EMAIL_API_KEY: e.EMAIL_API_KEY || "",
  EMAIL_FROM: e.EMAIL_FROM || "GOATSKINS <onboarding@resend.dev>",

  PRODUCAO: cfgProd.PRODUCAO,

  // Opcional: chave enviada apenas pelo proxy de borda confiável.
  // Não habilite sem configurar o proxy para injetá-la.
  ORIGIN_VERIFY_SECRET: e.ORIGIN_VERIFY_SECRET || "",

  TRUST_PROXY: e.TRUST_PROXY === "1",
  TRUST_PROXY_HOPS: Math.min(5, Math.max(1, Number(e.TRUST_PROXY_HOPS) || 1)),
  TESTE: e.TESTE === "1",

  // Mercado Pago: segredos só no servidor (.env).
  MP_ACCESS_TOKEN: e.MP_ACCESS_TOKEN || "",
  MP_WEBHOOK_SECRET: e.MP_WEBHOOK_SECRET || "",

  // Nunca vale em produção.
  MP_TESTE_APRO: !cfgProd.PRODUCAO && e.MP_TESTE_APRO === "1",

  MP_API_BASE: cfgProd.PRODUCAO
    ? "https://api.mercadopago.com"
    : (e.MP_API_BASE || "https://api.mercadopago.com"),

  PIX_MINUTOS: Math.min(60 * 24, Math.max(30, Number(e.PIX_MINUTOS) || 30)),

  // Janela de checkout: 5 minutos.
  // O servidor cancela a Order antes de liberar os números.
  RESERVA_MS: !cfgProd.PRODUCAO && Number(e.RESERVA_SEGUNDOS) > 0
    ? Number(e.RESERVA_SEGUNDOS) * 1000
    : 5 * 60e3
};