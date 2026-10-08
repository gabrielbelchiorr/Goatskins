/* Pré-carregado com `node -r`: troca o módulo "pg" por um banco falso que só responde "SELECT 1 ok" e devolve vazio no resto.
   Serve para testar o servidor HTTP (cabeçalhos, health check, limites) sem PostgreSQL. FALHAR_PING=1 simula banco fora do ar. */
const Module = require("node:module"), carregar = Module._load;
const query = async sql => {
  if (/SELECT 1 ok/.test(sql) && process.env.FALHAR_PING === "1") throw new Error("banco falso fora do ar");
  return { rows: /SELECT 1 ok/.test(sql) ? [{ ok: 1 }] : [], rowCount: 0 };
};
const falso = { Pool: class { on() {} query(s, p) { return query(s, p); } async connect() { return { query, release() {} }; } async end() {} }, types: { setTypeParser() {} } };
Module._load = function (req, ...r) { return req === "pg" ? falso : carregar.call(this, req, ...r); };
