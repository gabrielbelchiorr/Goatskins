/* Backup consistente do banco (VACUUM INTO). Uso:  node --no-warnings scripts/backup.js
   Guarda em data/backups/ e mantém os 14 mais recentes. Agende no Agendador de Tarefas (Windows) ou no cron (Linux). */
const fs = require("node:fs"), path = require("node:path");
const cfg = require("../src/config"), { db } = require("../src/db");
const pasta = path.join(cfg.DATA_DIR, "backups"); fs.mkdirSync(pasta, { recursive: true });
const destino = path.join(pasta, "goatskins-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db");
db.exec("VACUUM INTO '" + destino.replace(/'/g, "''") + "'");
fs.readdirSync(pasta).filter(f => f.endsWith(".db")).sort().reverse().slice(14).forEach(f => fs.unlinkSync(path.join(pasta, f)));
console.log("Backup criado:", destino);
