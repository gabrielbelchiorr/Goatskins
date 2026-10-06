/* Backup do PostgreSQL com pg_dump (precisa do cliente PostgreSQL instalado: comando "pg_dump").
   Uso:  node --no-warnings scripts/backup.js
   Guarda em data/backups/ (formato custom, restaure com pg_restore) e mantém os 14 mais recentes.
   Em produção no Render prefira os backups do próprio serviço de banco e use este script só para cópias extras.
   Atenção: o pg_dump deve ser da mesma versão (ou mais nova) que o PostgreSQL do servidor. */
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const cfg = require("../src/config");
const pasta = path.join(cfg.DATA_DIR, "backups"); fs.mkdirSync(pasta, { recursive: true });
const destino = path.join(pasta, "goatskins-" + new Date().toISOString().replace(/[:.]/g, "-") + ".dump");
try {
  execFileSync("pg_dump", ["--format=custom", "--no-owner", "--file", destino, "--dbname", cfg.DATABASE_URL], { stdio: ["ignore", "ignore", "pipe"] });
} catch (e) { // a mensagem original contém a URL do banco (com senha): não imprimir
  try { fs.unlinkSync(destino); } catch (_) { /* nada criado */ }
  console.error(e.code === "ENOENT" ? "pg_dump não encontrado: instale o cliente PostgreSQL." : "Falha no pg_dump:\n" + String(e.stderr || "").trim().replace(/postgres(ql)?:\/\/\S+/g, "[url oculta]"));
  process.exit(1);
}
fs.readdirSync(pasta).filter(f => f.endsWith(".dump")).sort().reverse().slice(14).forEach(f => fs.unlinkSync(path.join(pasta, f)));
console.log("Backup criado:", destino);
