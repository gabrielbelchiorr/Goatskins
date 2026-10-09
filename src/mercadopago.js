/* Cliente mínimo da Orders API do Mercado Pago (Pix) + validação de assinatura do webhook.
   O Access Token só existe aqui, no servidor. Nunca vai para o navegador nem para logs. */

const crypto = require("node:crypto");
const cfg = require("./config");

const configurado = () => !!(cfg.MP_ACCESS_TOKEN && cfg.MP_WEBHOOK_SECRET);

// Aviso único na inicialização (sem imprimir nenhum segredo): ajuda a achar no log do Render se faltou variável.
if (!cfg.TESTE) {
  console.log("[mp] pagamentos " + (configurado() ? "ativos" : "DESATIVADOS (faltam MP_ACCESS_TOKEN e/ou MP_WEBHOOK_SECRET)") +
    (cfg.MP_TESTE_APRO ? " | MODO TESTE APRO ligado (somente desenvolvimento)" : ""));
}

async function chamar(metodo, caminho, corpo, chaveIdempotencia) {
  const r = await fetch(cfg.MP_API_BASE + caminho, {
    method: metodo,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + cfg.MP_ACCESS_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(chaveIdempotencia ? { "X-Idempotency-Key": chaveIdempotencia } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    // a mensagem só inclui o que o Mercado Pago respondeu (nunca o token nem os cabeçalhos enviados)
    const e = new Error("Mercado Pago HTTP " + r.status + " " + JSON.stringify(d.errors || d.message || "").slice(0, 300));
    e.status = r.status;
    throw e;
  }

  return d;
}

function criarOrder({ ref, totalCentavos, email }) {
  const valor = (totalCentavos / 100).toFixed(2);

  return chamar("POST", "/v1/orders", {
    type: "online",
    total_amount: valor,
    external_reference: ref,
    processing_mode: "automatic",
    transactions: {
      payments: [{
        amount: valor,
        payment_method: { id: "pix", type: "bank_transfer" },
        expiration_time: "PT" + cfg.PIX_MINUTOS + "M"
      }]
    },
    // MP_TESTE_APRO só vale fora de produção (config.js zera em produção e recusa subir se estiver ligado)
    payer: { email, ...(cfg.MP_TESTE_APRO ? { first_name: "APRO" } : {}) }
  }, ref);
}

const buscarOrder = id => chamar("GET", "/v1/orders/" + encodeURIComponent(id));
// O Pix online tem prazo mínimo de 30 minutos no MP. Após 5 min da reserva,
// tentamos cancelar a Order; a reserva só é liberada DEPOIS de confirmar o cancelamento.
const cancelarOrder = (id, ref) => chamar("POST", "/v1/orders/" + encodeURIComponent(id) + "/cancel", undefined, ref + "-cancel");

/* Valida o x-signature conforme a documentação do Mercado Pago:
   manifesto = "id:<data.id em minúsculas>;request-id:<x-request-id>;ts:<ts>;" assinado com HMAC-SHA256 usando a
   chave secreta do webhook. O data.id vem do query string (?data.id=ORD...&type=order). */
function assinaturaValida(xSignature, xRequestId, dataId) {
  if (!cfg.MP_WEBHOOK_SECRET || typeof xSignature !== "string" || !dataId) return false;

  let ts, v1;
  for (const parte of xSignature.split(",")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const k = parte.slice(0, i).trim(), v = parte.slice(i + 1).trim();
    if (k === "ts") ts = v; else if (k === "v1") v1 = v;
  }
  if (!ts || !v1) return false;

  const recebido = Buffer.from(v1);
  // A documentação manda usar o id em minúsculas; aceitamos também o id como veio, por segurança.
  // Não enfraquece nada: continua exigindo o HMAC com o segredo.
  for (const id of new Set([String(dataId).toLowerCase(), String(dataId)])) {
    const partes = ["id:" + id];
    if (xRequestId) partes.push("request-id:" + xRequestId);
    partes.push("ts:" + ts);
    const calculado = Buffer.from(crypto.createHmac("sha256", cfg.MP_WEBHOOK_SECRET).update(partes.join(";") + ";").digest("hex"));
    if (calculado.length === recebido.length && crypto.timingSafeEqual(calculado, recebido)) return true;
  }
  return false;
}

module.exports = { configurado, criarOrder, buscarOrder, cancelarOrder, assinaturaValida };