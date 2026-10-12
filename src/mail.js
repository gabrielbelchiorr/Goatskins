/* Envio transacional pelo Resend. Aceito pelo provedor NÃO significa entregue na caixa de entrada. */
const fs = require("node:fs"), path = require("node:path"), cfg = require("./config");
async function enviarObrigatorio(para, assunto, texto) {
  if (cfg.EMAIL_DRIVER === "resend") {
    let r;
    try {
      r = await fetch("https://api.resend.com/emails", { method: "POST",
        headers: { Authorization: "Bearer " + cfg.EMAIL_API_KEY, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ from: cfg.EMAIL_FROM, to: [para], subject: assunto, text: texto }) });
    } catch (_) { throw new Error("RESEND_REDE_OU_TIMEOUT"); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const nome = typeof d.name === "string" && /^[a-z_]{1,60}$/.test(d.name) ? d.name : "erro";
      throw new Error("RESEND_HTTP_" + r.status + "_" + nome);
    }
    if (typeof d.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(d.id)) throw new Error("RESEND_RESPOSTA_INVALIDA");
    console.log("[e-mail] aceito pelo Resend id=" + d.id);
    return { simulado: false, id: d.id };
  }
  if (cfg.EMAIL_DRIVER !== "console" || cfg.PRODUCAO) throw new Error("EMAIL_DRIVER_INVALIDO");
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(cfg.DATA_DIR, "emails.log"), "=== para: " + para + "\nassunto: " + assunto + "\n" + texto + "\n\n", { mode: 0o600 });
  if (!cfg.TESTE) console.log("[e-mail] SIMULADO: mensagem gravada localmente; nada enviado");
  return { simulado: true };
}
// Compatibilidade com avisos de pagamento/sorteio: falhar no aviso não desfaz a operação.
const enviar = (...a) => enviarObrigatorio(...a).catch(e => { console.error("[e-mail]", e.message); return null; });
module.exports = { enviar, enviarObrigatorio };
