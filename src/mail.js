/* E-mails. Driver "console": grava em data/emails.log (para testar sem serviço externo).
   Driver "resend": envia de verdade pela API do Resend (precisa de EMAIL_API_KEY no .env). */
const fs = require("node:fs"), path = require("node:path"), cfg = require("./config");
async function enviar(para, assunto, texto) {
  if (cfg.EMAIL_DRIVER === "resend") {
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: "Bearer " + cfg.EMAIL_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.EMAIL_FROM, to: [para], subject: assunto, text: texto }) });
    if (!r.ok) throw new Error("Falha ao enviar e-mail: HTTP " + r.status);
    return;
  }
  fs.appendFileSync(path.join(cfg.DATA_DIR, "emails.log"), "=== para: " + para + "\nassunto: " + assunto + "\n" + texto + "\n\n");
  if (!cfg.TESTE) console.log("[e-mail simulado] para " + para + " | " + assunto);
}
const enviarSeguro = (...a) => enviar(...a).catch(e => console.error(e.message)); // nunca derruba a requisição
module.exports = { enviar: enviarSeguro };
