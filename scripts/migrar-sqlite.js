/* Copia os dados de um banco SQLite antigo (data/goatskins.db) para o PostgreSQL do DATABASE_URL.
   Uso:  node --no-warnings scripts/migrar-sqlite.js [caminho/goatskins.db]
   - O SQLite é aberto SOMENTE para leitura: o arquivo original não é alterado.
   - Roda numa única transação: se algo falhar, o PostgreSQL fica como estava.
   - Só funciona se o PostgreSQL de destino ainda estiver vazio (sem usuários nem sorteios).
   - Sessões de login e links de e-mail pendentes NÃO são copiados: todos precisarão entrar de novo.
   - Mantém os ids e acerta as sequências, então novos registros continuam a numeração. */
const fs = require("node:fs"), path = require("node:path"), { DatabaseSync } = require("node:sqlite");
const cfg = require("../src/config"), { db, tx, iniciar, fechar } = require("../src/db");

const origem = path.resolve(process.argv[2] || cfg.SQLITE_PATH);
const TABELAS = ["users", "campaigns", "tickets", "winners", "settings", "pedidos", "reservas", "notifications", "audit_logs"]; // ordem respeita as chaves estrangeiras
const COM_ID = ["users", "campaigns", "tickets", "pedidos", "notifications", "audit_logs"];

function falhar(msg) { console.error("ERRO: " + msg); process.exit(1); }

(async () => {
  if (!fs.existsSync(origem)) falhar("arquivo SQLite não encontrado: " + origem);
  const src = new DatabaseSync(origem, { readOnly: true });
  const versao = src.prepare("PRAGMA user_version").get().user_version;
  if (versao < 4) falhar("o SQLite está na versão " + versao + " (precisa ser 4). Abra o sistema antigo (versão SQLite) uma vez para atualizar o arquivo e rode de novo.");
  await iniciar();
  if ((await db.get("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM campaigns) n")).n > 0)
    falhar("o PostgreSQL de destino já tem dados. Para refazer, apague as tabelas (ou crie um banco novo) e rode de novo.");

  const contagens = await tx(async () => {
    const out = {};
    for (const t of TABELAS) {
      const existe = src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      const linhas = existe ? src.prepare("SELECT * FROM " + t + " ORDER BY rowid").all() : [];
      out[t] = linhas.length;
      if (!linhas.length) { console.log(t.padEnd(14) + " 0 linhas"); continue; }
      const alvo = new Set((await db.all("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?", [t])).map(r => r.column_name));
      const cols = Object.keys(linhas[0]).filter(c => alvo.has(c)), descartadas = Object.keys(linhas[0]).filter(c => !alvo.has(c));
      if (descartadas.length) console.log("  (colunas ignoradas em " + t + ": " + descartadas.join(", ") + ")");
      const sql = "INSERT INTO " + t + "(" + cols.map(c => '"' + c + '"').join(",") + ") VALUES(" + cols.map(() => "?").join(",") + ")";
      for (const l of linhas) await db.run(sql, cols.map(c => l[c]));
      console.log(t.padEnd(14) + " " + linhas.length + " linhas copiadas");
    }
    for (const t of COM_ID) // próximo id = maior id + 1
      await db.get("SELECT setval(pg_get_serial_sequence('" + t + "','id'), COALESCE((SELECT MAX(id) FROM " + t + "),0)+1, false)");
    for (const t of TABELAS) { // conferência: o que entrou tem que bater com o que saiu
      const n = (await db.get("SELECT COUNT(*) n FROM " + t)).n;
      if (n !== out[t]) throw new Error("contagem diferente em " + t + ": origem " + out[t] + ", destino " + n);
    }
    return out;
  });
  src.close();
  console.log("\nMigração concluída e conferida:", JSON.stringify(contagens));
  await fechar();
})().catch(e => { console.error("Falha na migração (nada foi gravado):", e.message); process.exit(1); });
