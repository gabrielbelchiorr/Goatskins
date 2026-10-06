/* Cliente mínimo da Orders API do Mercado Pago (Pix) + validação de assinatura do webhook.
   O Access Token só existe aqui, no servidor. Nunca vai para o navegador nem para logs. */

const crypto = require("node:crypto");
const cfg = require("./config");

const configurado = () => !!(cfg.MP_ACCESS_TOKEN && cfg.MP_WEBHOOK_SECRET);

async function chamar(metodo, caminho, corpo, chaveIdempotencia) {
  const r = await fetch(cfg.MP_API_BASE + caminho, {
    method: metodo,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + cfg.MP_ACCESS_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(chaveIdempotencia
        ? { "X-Idempotency-Key": chaveIdempotencia }
        : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    const e = new Error(
      "Mercado Pago HTTP " +
        r.status +
        " " +
        JSON.stringify(d.errors || d.message || "").slice(0, 300)
    );
    e.status = r.status;
    throw e;
  }

  return d;
}

function criarOrder({ ref, totalCentavos, email }) {
  const valor = (totalCentavos / 100).toFixed(2);

  return chamar(
    "POST",
    "/v1/orders",
    {
      type: "online",
      total_amount: valor,
      external_reference: ref,
      processing_mode: "automatic",

      transactions: {
        payments: [
          {
            amount: valor,
            payment_method: {
              id: "pix",
              type: "bank_transfer"
            },
            expiration_time: "PT" + cfg.PIX_MINUTOS + "M"
          }
        ]
      },

      payer: {
        email,
        ...(process.env.MP_TESTE_APRO === "1"
          ? { first_name: "APRO" }
          : {})
      }
    },
    ref
  );
}

const buscarOrder = (id) =>
  chamar("GET", "/v1/orders/" + encodeURIComponent(id));

function assinaturaValida(xSignature, xRequestId, dataId) {
  if (!cfg.MP_WEBHOOK_SECRET || typeof xSignature !== "string" || !dataId) {
    return false;
  }

  let ts;
  let v1;

  for (const parte of xSignature.split(",")) {
    const i = parte.indexOf("=");

    if (i < 0) continue;

    const k = parte.slice(0, i).trim();
    const v = parte.slice(i + 1).trim();

    if (k === "ts") {
      ts = v;
    } else if (k === "v1") {
      v1 = v;
    }
  }

  if (!ts || !v1) return false;

  const partes = ["id:" + String(dataId).toLowerCase()];

  if (xRequestId) {
    partes.push("request-id:" + xRequestId);
  }

  partes.push("ts:" + ts);

  const calculado = Buffer.from(
    crypto
      .createHmac("sha256", cfg.MP_WEBHOOK_SECRET)
      .update(partes.join(";") + ";")
      .digest("hex")
  );

  const recebido = Buffer.from(v1);

  return (
    calculado.length === recebido.length &&
    crypto.timingSafeEqual(calculado, recebido)
  );
}

module.exports = {
  configurado,
  criarOrder,
  buscarOrder,
  assinaturaValida
};
