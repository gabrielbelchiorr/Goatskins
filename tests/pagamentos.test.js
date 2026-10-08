const ambienteTeste = require("./helpers/ambiente-teste");
/* Testes offline do fluxo de pagamento (sem banco real e sem rede): `node --test tests/pagamentos.test.js`
   O módulo "pg" é substituído por um banco falso em memória, e o fetch pelo Mercado Pago também. */
process.env.NODE_ENV = "test"; process.env.TESTE = "1";
process.env.MP_ACCESS_TOKEN = "TOKEN-DE-TESTE"; process.env.MP_WEBHOOK_SECRET = "segredo-de-teste";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), Module = require("node:module");

/* ---- banco falso: só entende as consultas usadas pelo fluxo de pagamento ---- */
const ORD = "ORD01JQ4S4KY8HWQ6NA5PXB65B3D3", PUB = "a".repeat(32);
const S = { pedido: null, tickets: [], notificacoes: 0, auditorias: [], reservaN: 2, ticketsUser: 0, reservasUser: 0, lim: { m: 5, max: 10 }, ocupados: [], campStatus: "OPEN" };
const reset = (status = "PENDING", extra = {}) => {
  S.pedido = { id: 1, public_id: PUB, user_id: 7, campaign_id: 3, numeros: "[5,9]", total_centavos: 200, status, mp_order_id: ORD };
  S.tickets = []; S.notificacoes = 0; S.auditorias = []; enviados.length = 0;
  Object.assign(S, { reservaN: 2, ticketsUser: 0, reservasUser: 0, lim: { m: 5, max: 10 }, ocupados: [], campStatus: "OPEN" }, extra);
};
const enviados = []; // e-mails que o sistema tentou mandar
async function query(sql, p = []) {
  const q = sql.replace(/\s+/g, " "), rows = r => ({ rows: r, rowCount: r.length });
  if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(q)) return rows([]);
  if (q.includes("SET status='EXPIRED'") || q.includes("DELETE FROM reservas WHERE pedido_id IN")) return rows([]);
  if (q.startsWith("SELECT * FROM pedidos WHERE id=")) return rows([{ ...S.pedido }]);
  if (q.startsWith("SELECT id, mp_order_id FROM pedidos WHERE mp_order_id=")) return rows(p[0] === S.pedido.mp_order_id ? [{ id: 1, mp_order_id: ORD }] : []);
  if (q.startsWith("SELECT status FROM campaigns")) return rows([{ status: S.campStatus }]);
  if (q.startsWith("SELECT status FROM pedidos WHERE id=")) return rows([{ status: S.pedido.status }]);
  if (q.startsWith("SELECT COUNT(*) n FROM reservas WHERE pedido_id")) return rows([{ n: S.reservaN }]);
  if (q.startsWith("SELECT COUNT(*) n FROM tickets WHERE campaign_id=")) return rows([{ n: S.ticketsUser }]);
  if (q.startsWith("SELECT COUNT(*) n FROM reservas r JOIN pedidos q")) return rows([{ n: S.reservasUser }]);
  if (q.startsWith("SELECT max_por_usuario m, max FROM campaigns")) return rows([S.lim]);
  if (q.startsWith("SELECT 1 FROM tickets WHERE campaign_id=")) return rows(S.ocupados.includes(p[1]) ? [{}] : []);
  if (q.startsWith("SELECT 1 FROM reservas WHERE campaign_id=")) return rows([]);
  if (q.startsWith("SELECT nome, email FROM users")) return rows([{ nome: "Ana", email: "ana@teste.com" }]);
  if (q.startsWith("UPDATE pedidos SET status=$")) { S.pedido.status = p[0]; return rows([]); }
  if (q.includes("SET status='REFUND_NEEDED'")) { S.pedido.status = "REFUND_NEEDED"; return rows([]); }
  if (q.startsWith("INSERT INTO tickets")) { if (S.tickets.some(t => t[2] === p[2])) { const e = new Error("dup"); e.code = "23505"; throw e; } S.tickets.push(p); return rows([]); }
  if (q.startsWith("DELETE FROM reservas WHERE pedido_id=")) return rows([]);
  if (q.includes("SET status='PAID'")) { S.pedido.status = "PAID"; return rows([]); }
  if (q.startsWith("UPDATE pedidos SET mp_status")) return rows([]);
  if (q.startsWith("INSERT INTO audit_logs")) { S.auditorias.push(p[2]); return rows([]); }
  if (q.startsWith("INSERT INTO notifications")) { S.notificacoes++; return rows([]); }
  throw new Error("consulta não prevista no teste: " + q.slice(0, 90));
}
const fakePg = { Pool: class { on() {} query(s, p) { return query(s, p); } async connect() { return { query, release() {} }; } }, types: { setTypeParser() {} } };
const carregar = Module._load;
Module._load = function (req, ...r) { return req === "pg" ? fakePg : carregar.call(this, req, ...r); };

const mp = require("../src/mercadopago"), ped = require("../src/pedidos"), mail = require("../src/mail");
mail.enviar = (...a) => { enviados.push(a); }; // não envia nada de verdade; pedidos.js chama mail.enviar no momento do uso
const orderPaga = (extra = {}) => ({ id: ORD, external_reference: PUB, status: "processed", status_detail: "accredited", total_amount: "2.00", total_paid_amount: "2.00",
  transactions: { payments: [{ status: "processed", status_detail: "accredited", paid_amount: "2.00" }] }, ...extra });
const assinar = (id, reqId = "req-1", ts = "1742505638683", segredo = "segredo-de-teste") =>
  "ts=" + ts + ",v1=" + crypto.createHmac("sha256", segredo).update("id:" + id.toLowerCase() + ";request-id:" + reqId + ";ts:" + ts + ";").digest("hex");

test("assinatura: válida com id em minúsculas no manifesto", () => assert.equal(mp.assinaturaValida(assinar(ORD), "req-1", ORD), true));
test("assinatura: recusa segredo errado, request-id trocado, id trocado e cabeçalho ausente", () => {
  assert.equal(mp.assinaturaValida(assinar(ORD, "req-1", "1", "outro-segredo"), "req-1", ORD), false);
  assert.equal(mp.assinaturaValida(assinar(ORD), "req-2", ORD), false);
  assert.equal(mp.assinaturaValida(assinar(ORD), "req-1", "ORDOUTROIDOUTROID"), false);
  assert.equal(mp.assinaturaValida(undefined, "req-1", ORD), false);
  assert.equal(mp.assinaturaValida("ts=1", "req-1", ORD), false);
});

test("interpretar: pago, valor divergente, pendente, expirado, referência diferente", () => {
  const p = { mp_order_id: ORD, public_id: PUB, total_centavos: 200 };
  assert.equal(ped.interpretar(orderPaga(), p).estado, "PAGO");
  assert.equal(ped.interpretar(orderPaga({ total_paid_amount: "1.00" }), p).estado, "PENDENTE");
  assert.equal(ped.interpretar(orderPaga({ total_amount: "1.00" }), p).estado, "PENDENTE");
  assert.equal(ped.interpretar({ id: ORD, external_reference: PUB, status: "action_required", status_detail: "waiting_transfer", transactions: { payments: [{ status: "action_required" }] } }, p).estado, "PENDENTE");
  assert.deepEqual(ped.interpretar({ id: ORD, external_reference: PUB, status: "expired", transactions: { payments: [{ status: "expired" }] } }, p), { estado: "FALHOU", novo: "EXPIRED" });
  assert.equal(ped.interpretar(orderPaga({ external_reference: "b".repeat(32) }), p).estado, "PENDENTE");
});

test("aplicar: paga uma vez e é idempotente (mesma notificação 3x = 1 compra)", async () => {
  reset();
  assert.equal(await ped.aplicar(1, orderPaga()), "PAID");
  assert.equal(await ped.aplicar(1, orderPaga()), "PAID");
  assert.equal(await ped.aplicar(1, orderPaga()), "PAID");
  assert.equal(S.tickets.length, 2); assert.equal(S.notificacoes, 1);
  assert.equal(S.auditorias.filter(a => a === "PAGAMENTO_CONFIRMADO").length, 1);
});

test("aplicar: pagamento com valor diferente NÃO confirma", async () => {
  reset(); assert.equal(await ped.aplicar(1, orderPaga({ total_paid_amount: "0.50" })), "PENDING"); assert.equal(S.tickets.length, 0);
});

/* ---- rota do webhook, ponta a ponta ---- */
const rota = ped.rotas.find(r => r[1].source.includes("webhooks"))[2];
const chamar = async (query, headers, body = {}) => rota({ query, body, ip: "1.2.3.4", req: { headers } });
const comFetch = (order, fn) => async () => { const antes = global.fetch; global.fetch = async () => ({ ok: true, json: async () => order }); try { await fn(); } finally { global.fetch = antes; } };

test("webhook: sem assinatura = 401", async () => {
  await assert.rejects(chamar({ "data.id": ORD, type: "order" }, {}), e => e.code === 401);
});
test("webhook: assinatura errada = 401", async () => {
  await assert.rejects(chamar({ "data.id": ORD, type: "order" }, { "x-signature": assinar(ORD, "r", "1", "errado"), "x-request-id": "r" }), e => e.code === 401);
});
test("webhook: simulação do painel (id numérico) com assinatura válida = 200 e nada muda", async () => {
  reset(); const r = await chamar({ "data.id": "123456", type: "order" }, { "x-signature": assinar("123456"), "x-request-id": "req-1" });
  assert.deepEqual(r, { ok: true }); assert.equal(S.pedido.status, "PENDING");
});
test("webhook: pagamento real confirma o pedido e repetir não duplica", comFetch(orderPaga(), async () => {
  reset(); const h = { "x-signature": assinar(ORD), "x-request-id": "req-1" };
  for (let i = 0; i < 3; i++) assert.deepEqual(await chamar({ "data.id": ORD, type: "order" }, h), { ok: true });
  assert.equal(S.pedido.status, "PAID"); assert.equal(S.tickets.length, 2);
}));
test("webhook: id e tipo só no corpo JSON (sem query) também funciona", comFetch(orderPaga(), async () => {
  reset(); const h = { "x-signature": assinar(ORD), "x-request-id": "req-1" };
  assert.deepEqual(await chamar({}, h, { type: "order", action: "order.processed", data: { id: ORD } }), { ok: true });
  assert.equal(S.pedido.status, "PAID");
}));

test("aplicar: e-mail de confirmação sai UMA vez, só depois de pagar, e não derruba nada se o envio falhar", async () => {
  reset(); await ped.aplicar(1, orderPaga()); await ped.aplicar(1, orderPaga()); await ped.aplicar(1, orderPaga());
  assert.equal(enviados.length, 1); assert.equal(enviados[0][0], "ana@teste.com"); assert.match(enviados[0][2], /5, 9/);
  reset(); const antes = mail.enviar; mail.enviar = () => { throw new Error("provedor fora do ar"); };
  try { assert.equal(await ped.aplicar(1, orderPaga()), "PAID"); } finally { mail.enviar = antes; }   // falha de e-mail não desfaz o pagamento
  reset(); await ped.aplicar(1, orderPaga({ total_paid_amount: "1.00" })); assert.equal(enviados.length, 0);
});

test("pagamento tardio: reserva venceu mas números livres e dentro do limite = vende", async () => {
  reset("EXPIRED", { reservaN: 0 });
  assert.equal(await ped.aplicar(1, orderPaga()), "PAID"); assert.equal(S.tickets.length, 2);
});
test("pagamento tardio: número já vendido para outra pessoa = REFUND_NEEDED, nada é vendido duas vezes", async () => {
  reset("EXPIRED", { reservaN: 0, ocupados: [9] });
  assert.equal(await ped.aplicar(1, orderPaga()), "REFUND_NEEDED"); assert.equal(S.tickets.length, 0);
  assert.ok(S.auditorias.includes("PAGAMENTO_TARDIO_REEMBOLSAR")); assert.equal(enviados.length, 0);
});
test("pagamento tardio: não fura o limite de números por pessoa (já tem 4 de 5 e este pedido é de 2)", async () => {
  reset("EXPIRED", { reservaN: 0, ticketsUser: 4 });
  assert.equal(await ped.aplicar(1, orderPaga()), "REFUND_NEEDED"); assert.equal(S.tickets.length, 0);
});
test("pagamento tardio: sorteio encerrado ou número fora das vagas = REFUND_NEEDED", async () => {
  reset("EXPIRED", { reservaN: 0, campStatus: "CLOSED" }); assert.equal(await ped.aplicar(1, orderPaga()), "REFUND_NEEDED");
  reset("EXPIRED", { reservaN: 0, lim: { m: 5, max: 8 } }); assert.equal(await ped.aplicar(1, orderPaga()), "REFUND_NEEDED"); // número 9 > 8 vagas
});
test("pedido já reembolsado/pendente de reembolso nunca volta a ser PAID por um webhook repetido", async () => {
  for (const st of ["REFUND_NEEDED", "REFUNDED"]) { reset(st); assert.equal(await ped.aplicar(1, orderPaga()), st); assert.equal(S.tickets.length, 0); }
});
test("pagamento cancelado/expirado no Mercado Pago marca o pedido e não vende nada", async () => {
  reset(); assert.equal(await ped.aplicar(1, { id: ORD, external_reference: PUB, status: "canceled", transactions: { payments: [{ status: "canceled" }] } }), "CANCELED");
  assert.equal(S.tickets.length, 0);
});
test("order de OUTRO pedido (referência ou id diferentes) nunca confirma este pedido", async () => {
  reset(); assert.equal(await ped.aplicar(1, orderPaga({ id: "ORDOUTRO00000000001" })), "PENDING");
  assert.equal(await ped.aplicar(1, orderPaga({ external_reference: "c".repeat(32) })), "PENDING"); assert.equal(S.tickets.length, 0);
});

test("Mercado Pago: o valor enviado vem em reais com 2 casas, com referência e idempotência; erro não vaza o token", async () => {
  const antes = global.fetch; let visto;
  global.fetch = async (url, o) => { visto = { url, o, corpo: JSON.parse(o.body) }; return { ok: false, status: 400, json: async () => ({ errors: [{ code: "x" }] }) }; };
  try {
    await assert.rejects(mp.criarOrder({ ref: PUB, totalCentavos: 1050, email: "a@b.com" }), e => { assert.ok(!e.message.includes("TOKEN-DE-TESTE")); return true; });
    assert.equal(visto.corpo.total_amount, "10.50"); assert.equal(visto.corpo.transactions.payments[0].amount, "10.50");
    assert.equal(visto.corpo.external_reference, PUB); assert.equal(visto.o.headers["X-Idempotency-Key"], PUB);
    assert.equal(visto.corpo.payer.first_name, undefined);   // modo APRO nunca vai junto fora do teste
  } finally { global.fetch = antes; }
});

test("BR Code: CRC16 confere com o vetor padrão e detecta código adulterado", () => {
  assert.equal(ped.crc16("123456789"), "29B1"); // vetor de teste oficial do CRC16-CCITT-FALSE
  const base = "00020126360014BR.GOV.BCB.PIX0114+5511999999999520400005303986540510.005802BR5909GOATSKINS6009SAO PAULO62070503***6304";
  const ok = base + ped.crc16(base);
  assert.equal(ped.brcodeOk(ok), true);
  assert.equal(ped.brcodeOk(ok.replace("10.00", "99.00")), false);
  assert.equal(ped.brcodeOk(ok.slice(0, -2)), false);
  assert.equal(ped.brcodeOk(null), false);
});