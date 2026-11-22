/* Alertas por e-mail para a administração: eventos que pedem uma ação humana (pagamento a devolver,
   Pix em dúvida, autenticador bloqueado...). Disparados por audit() DEPOIS do commit, então nunca
   avisam algo que foi desfeito. Cada tipo manda no máximo um e-mail a cada INTERVALO_MS; o próximo
   informa quantos aconteceram nesse meio-tempo. O detalhe vem da auditoria (ids de pedido e campanha,
   nunca senhas, tokens ou dados de pagamento). */
const cfg = require("./config"), mail = require("./mail");
const { db } = require("./db");

const ALERTAS = Object.freeze({
  MFA_BLOQUEADO: "Autenticador de administrador bloqueado por códigos errados",
  PIX_CRIACAO_INCERTA: "Pix em dúvida: o Mercado Pago não confirmou a criação",
  PIX_CRIACAO_RECUSADA: "O Mercado Pago recusou gerar um Pix",
  PAGAMENTO_IGNORADO: "Pagamento ignorado por divergência (valor, moeda ou referência)",
  PAGAMENTO_TARDIO_REEMBOLSAR: "Pagamento depois do prazo: reembolso necessário",
  PAGAMENTO_CONTA_SUSPENSA: "Pagamento de conta suspensa: reembolso necessário",
  PAGAMENTO_ESTORNADO_NO_MP: "Pagamento estornado ou contestado no Mercado Pago",
  WEBHOOK_PEDIDO_DESCONHECIDO: "Pagamento no Mercado Pago sem pedido correspondente",
});
const INTERVALO_MS = 15 * 60e3;
const ultimo = new Map(); // acao -> { em, suprimidos }

async function enviar(acao, detalhe) {
  const titulo = ALERTAS[acao]; if (!titulo) return false;
  const agora = Date.now(), u = ultimo.get(acao);
  if (u && agora - u.em < INTERVALO_MS) { u.suprimidos++; return false; }
  ultimo.set(acao, { em: agora, suprimidos: 0 });
  const extras = u && u.suprimidos ? "\n\nMais " + u.suprimidos + " evento(s) deste tipo nos últimos " + Math.round(INTERVALO_MS / 60e3) + " minutos (veja todos no painel)." : "";
  let destinos;
  try { destinos = await db.all("SELECT email FROM users WHERE role IN ('ADMIN','SUPER_ADMIN') AND status='ACTIVE' AND email_verificado=1 AND email IS NOT NULL ORDER BY id LIMIT 10"); }
  catch (e) { console.error("[alerta] sem destinatários:", e.message); return false; }
  const texto = titulo + ".\n\nDetalhe: " + String(detalhe || "-").slice(0, 300) + "\nQuando: " + new Date(agora).toISOString() + extras +
    "\n\nConfira em Admin > Logs (filtro " + acao + "): " + cfg.APP_URL + "\n\nE-mail automático do GOATSKINS.";
  await Promise.all(destinos.map(d => mail.enviar(d.email, "[GOATSKINS] " + titulo, texto)));
  return destinos.length > 0;
}
const _zerar = () => ultimo.clear(); // só para testes
module.exports = { ALERTAS, enviar, INTERVALO_MS, _zerar };
