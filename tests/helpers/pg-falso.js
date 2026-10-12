/* Stub somente para testes HTTP/validação. Não simula transações nem comprova SQL. */
const Module = require('node:module'), carregar = Module._load;
const query = async sql => {
  if (/^SELECT 1 ok/.test(sql) && process.env.FALHAR_PING === '1') throw new Error('banco offline simulado');
  const rows = /^SELECT 1 ok/.test(sql) ? [{ ok: 1 }] : /COUNT\(/i.test(sql) ? [{ n: 0 }] : [];
  return { rows, rowCount: rows.length };
};
const pg = { Pool: class { on() {} query(sql) { return query(sql); } async connect() { return { query, release() {} }; } async end() {} }, types: { setTypeParser() {} } };
Module._load = function (name, ...args) { return name === 'pg' ? pg : carregar.call(this, name, ...args); };
