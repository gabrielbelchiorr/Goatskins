const ambienteTeste = require("./helpers/ambiente-teste");
/* Testes unitários offline (sem banco e sem rede): `npm run test:unit` */
process.env.NODE_ENV = "test"; process.env.TESTE = ""; process.env.TRUST_PROXY = "1"; process.env.TRUST_PROXY_HOPS = "2";
require("./helpers/pg-falso");
const test = require("node:test"), assert = require("node:assert/strict"), { spawnSync } = require("node:child_process"), path = require("node:path");
const auth = require("../src/auth"), http = require("../src/http");

test("senha: hash com sal, formato sal:hex, confere certo e recusa errado/lixo", async () => {
  const h1 = await auth.hashSenha("Senha1234"), h2 = await auth.hashSenha("Senha1234");
  assert.match(h1, /^[a-f0-9]{32}:[a-f0-9]{128}$/); assert.notEqual(h1, h2); assert.ok(!h1.includes("Senha1234"));
  assert.equal(await auth.confere("Senha1234", h1), true); assert.equal(await auth.confere("senha1234", h1), false);
  for (const lixo of [null, "", "semdoispontos", "abc:zzzz", ":"]) assert.equal(await auth.confere("x", lixo), false);
});
test("senha: scrypt não trava o servidor (várias verificações em paralelo deixam o laço de eventos livre)", async () => {
  const h = await auth.hashSenha("Senha1234"); let batidas = 0; const t = setInterval(() => batidas++, 5);
  await Promise.all(Array.from({ length: 12 }, () => auth.confere("errada123", h))); clearInterval(t);
  assert.ok(batidas >= 3, "o timer só rodou " + batidas + " vezes: o hash está bloqueando o processo");
});
test("senhaOk: exige 8+ caracteres, letra e número", () => {
  for (const s of ["abc", "abcdefgh", "12345678", "", null, undefined, "a1".repeat(60), 12345678]) assert.equal(auth.senhaOk(s), false, String(s));
  assert.equal(auth.senhaOk("Senha1234"), true);
});

test("limite: bloqueia após o máximo, por chave, e a poda não perdoa quem ainda está na janela", () => {
  const k = "t:" + Math.random(); for (let i = 0; i < 3; i++) http.limite(k, 3, 60000);
  assert.throws(() => http.limite(k, 3, 60000), e => e.code === 429);
  http.limite(k + "outra", 3, 60000);                                   // outra chave não é afetada
  assert.ok(http._baldes.has(k));
});

test("ipDe: com 2 proxies confiáveis usa a 2ª entrada a partir da direita; o que o cliente forja à esquerda é ignorado", () => {
  const req = (xff, ip = "10.0.0.1") => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: ip } });
  assert.equal(http.ipDe(req("6.6.6.6, 1.1.1.1, 2.2.2.2")), "1.1.1.1");  // 6.6.6.6 = forjado pelo cliente
  assert.equal(http.ipDe(req("9.9.9.9")), "9.9.9.9"); assert.equal(http.ipDe(req(null, "7.7.7.7")), "7.7.7.7");
});

test("validação de entrada: txt, inteiro, foto, abrev", () => {
  assert.equal(http.txt("  oi  ", 5, 1), "oi");
  for (const v of [5, null, {}, [], "", "x".repeat(81)]) assert.throws(() => http.txt(v, 80, 1), e => e.code === 400);
  assert.equal(http.inteiro("7", 1, 100), 7);
  for (const v of [0, 101, 1.5, "a", null, NaN, Infinity, "1e2", "0x10", true, [5], {}, "", " "]) assert.throws(() => http.inteiro(v, 1, 100), e => e.code === 400, String(v));
  assert.equal(http.foto("", 10), "");
  for (const v of ["data:image/png;base64,AAAA", "data:image/jpeg;base64,<script>", "data:image/jpeg;base64,AAAA".padEnd(5000, "A"), 7]) assert.throws(() => http.foto(v, 100), e => e.code === 400);
  assert.equal(http.foto("data:image/jpeg;base64,/9j/AAAA", 100), "data:image/jpeg;base64,/9j/AAAA");
  assert.equal(http.abrev("Ana Maria Souza"), "Ana S."); assert.equal(http.abrev("Ana"), "Ana");
});

const config = env => spawnSync(process.execPath, ["--no-warnings", "-e", "require('./src/config')"], { cwd: path.join(__dirname, ".."), encoding: "utf8",
  env: { ...process.env, ...ambienteTeste, NODE_ENV: "production", ...env } });
test("config de produção: recusa configurações inseguras e aceita uma correta", () => {
  const bom = { APP_URL: "https://x.com.br", DATABASE_URL: "postgresql://u:p@h:5432/d", EMAIL_DRIVER: "resend", EMAIL_API_KEY: "k", TRUST_PROXY: "1" };
  const valido = config(bom); assert.equal(valido.status, 0, valido.stderr);
  for (const [ruim, esperado] of [[{ APP_URL: "http://x.com" }, /https/], [{ DATABASE_URL: "" }, /DATABASE_URL/], [{ EMAIL_DRIVER: "console" }, /EMAIL_DRIVER/],
    [{ MP_ACCESS_TOKEN: "t" }, /MP_WEBHOOK_SECRET/], [{ EMAIL_API_KEY: "" }, /EMAIL_API_KEY/], [{ TESTE: "1" }, /TESTE/], [{ MP_TESTE_APRO: "1" }, /MP_TESTE_APRO/]]) {
    const r = config({ ...bom, ...ruim }); assert.equal(r.status, 1, JSON.stringify(ruim)); assert.match(r.stderr, esperado);
  }
});
test("config: em produção a URL da API do Mercado Pago e o modo APRO não podem ser trocados por variável", () => {
  const r = spawnSync(process.execPath, ["-e", "const c=require('./src/config');process.stdout.write(c.MP_API_BASE + ' ' + String(c.MP_TESTE_APRO))"], { cwd: path.join(__dirname, ".."), encoding: "utf8",
    env: { ...process.env, ...ambienteTeste, NODE_ENV: "production", APP_URL: "https://x.com.br", DATABASE_URL: "postgresql://u:p@h/d", EMAIL_DRIVER: "resend", EMAIL_API_KEY: "k", MP_API_BASE: "http://evil.local" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://api.mercadopago.com false");
});
