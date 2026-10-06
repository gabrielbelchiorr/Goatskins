/* Testes offline do fluxo de pagamento (sem banco real e sem rede): `node --test tests/pagamentos.test.js`
   O módulo "pg" é substituído por um banco falso em memória, e o fetch pelo Mercado Pago também. */
process.env.NODE_ENV = "test"; process.env.TESTE = "1";
process.env.MP_ACCESS_TOKEN = "TOKEN-DE-TESTE"; process.env.MP_WEBHOOK_SECRET = "segredo-de-teste";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), Module = require("node:module");

/* ---- banco falso: só entende as consultas usadas pelo fluxo de pagamento ---- */
const ORD = "ORD01JQ4S4KY8HWQ6NA5PXB65B3D3", PUB = "a".repeat(32);
const S = { pedido: null, tickets: [], notificacoes: 0, auditorias: [] };
const reset = (status = "PENDING") => {
  S.pedido = { id: 1, public_id: PUB, user_id: 7, campaign_id: 3, numeros: "[5,9]", total_centavos: 200, status, mp_order_id: ORD };
  S.tickets = []; S.notificacoes = 0; S.auditorias = [];
};
async function query(sql, p = []) {
  const q = sql.replace(/\s+/g, " "), rows = r => ({ rows: r, rowCount: r.length });
  if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(q)) return rows([]);
  if (q.includes("SET status='EXPIRED'") || q.includes("DELETE FROM reservas WHERE pedido_id IN")) return rows([]);
  if (q.startsWith("SELECT * FROM pedidos WHERE id=")) return rows([{ ...S.pedido }]);
  if (q.startsWith("SELECT id, mp_order_id FROM pedidos WHERE mp_order_id=")) return rows(p[0] === S.pedido.mp_order_id ? [{ id: 1, mp_order_id: ORD }] : []);
  if (q.startsWith("SELECT status FROM campaigns")) return rows([{ status: "OPEN" }]);
  if (q.startsWith("SELECT COUNT(*) n FROM reservas WHERE pedido_id")) return rows([{ n: 2 }]);
  if (q.startsWith("INSERT INTO tickets")) { if (S.tickets.some(t => t[1] === p[2])) { const e = new Error("dup"); e.code = "23505"; throw e; } S.tickets.push(p); return rows([]); }
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

const mp = require("../src/mercadopago"), ped = require("../src/pedidos");
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

test("BR Code: CRC16 confere com o vetor padrão e detecta código adulterado", () => {
  assert.equal(ped.crc16("123456789"), "29B1"); // vetor de teste oficial do CRC16-CCITT-FALSE
  const base = "00020126360014BR.GOV.BCB.PIX0114+5511999999999520400005303986540510.005802BR5909GOATSKINS6009SAO PAULO62070503***6304";
  const ok = base + ped.crc16(base);
  assert.equal(ped.brcodeOk(ok), true);
  assert.equal(ped.brcodeOk(ok.replace("10.00", "99.00")), false);
  assert.equal(ped.brcodeOk(ok.slice(0, -2)), false);
  assert.equal(ped.brcodeOk(null), false);
});