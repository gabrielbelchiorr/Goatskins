/* Testes de segurança da rota de arquivamento: usam banco falso, nunca acessam PostgreSQL. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function preparar({status='CLOSED', archived=0, tickets=0, reservas=0, pendentes=0}={}) {
  const dados = { status, archived, tickets, reservas, pendentes };
  const chamadas = [];
  class Erro extends Error { constructor(message, code=400){ super(message);this.code=code; } }
  const db = {
    async get(sql) {
      if (sql.includes('SELECT status, archived FROM campaigns')) return {status:dados.status, archived:dados.archived};
      if (sql.includes('FROM tickets WHERE')) return {n:dados.tickets};
      if (sql.includes('FROM reservas WHERE')) return {n:dados.reservas};
      if (sql.includes('FROM pedidos WHERE')) return {n:dados.pendentes};
      throw new Error('Consulta inesperada: '+sql);
    },
    async run(sql) {
      chamadas.push(sql);
      if (sql.startsWith('UPDATE campaigns SET archived=1')) dados.archived=1;
      if (sql.startsWith('UPDATE campaigns SET archived=0')) dados.archived=0;
      return {changes:1};
    },
    async all() { return [{id:2,premio:'Teste',status:'CLOSED',pedidos:2}]; }
  };
  const mocks = {
    './db': {db,tx:fn=>fn(),liberar:async()=>{},agora:()=>'',audit:async(...args)=>chamadas.push(['audit', ...args]),novaSemente:()=>{}},
    './http': {Erro,RE:{},txt:()=>'',foto:()=>'',ipDe:()=>''},
    './rifas': {corpoCampanha:()=>{}, sortear:()=>{}, visual:()=>{}}
  };
  const codigo = fs.readFileSync(path.join(__dirname,'../src/admin.js'),'utf8');
  const sandbox = {module:{exports:{}},require:n=>{ if (!(n in mocks)) throw Error('Import inesperado '+n); return mocks[n]; }};
  vm.runInNewContext(codigo,sandbox, {filename:'admin.js'});
  const routes=sandbox.module.exports.rotas;
  const ctx={params:['2'],user:{id:1,role:'ADMIN'},ip:'127.0.0.1'};
  const archive=routes.find(r=>r[0]==='POST' && r[1].test('/api/admin/campanhas/2/arquivar'));
  const restore=routes.find(r=>r[0]==='POST' && r[1].test('/api/admin/campanhas/2/desarquivar'));
  const list=routes.find(r=>r[0]==='GET' && r[1].test('/api/admin/campanhas/arquivadas'));
  assert.ok(archive&&restore&&list);
  return {dados,chamadas,archive,restore,list,ctx};
}

test('arquiva somente CLOSED e sem registros ativos, preservando pedidos históricos', async()=>{
  const t=preparar();
  assert.equal(t.archive[3],'admin');
  assert.equal((await t.archive[2](t.ctx)).ok,true);
  assert.equal(t.dados.archived,1);
  assert.equal(t.chamadas.some(x=>typeof x==='string' && x.startsWith('DELETE')),false);
  assert.equal(t.chamadas.some(x=>Array.isArray(x)&&x[2]==='SORTEIO_ARQUIVADO'),true);
});

test('não arquiva sorteios em aberto, com participantes, reservas ou pedidos ativos', async()=>{
  for(const opt of [{status:'OPEN'}, {tickets:1}, {reservas:1}, {pendentes:1}]) {
    const t=preparar(opt);
    await assert.rejects(t.archive[2](t.ctx));
    assert.equal(t.dados.archived,0);
  }
});

test('arquivamento repetido não causa erro, e a restauração é reversível',async()=>{
  const t=preparar();
  await t.archive[2](t.ctx); await t.archive[2](t.ctx);
  assert.equal(t.dados.archived,1);
  assert.equal((await t.restore[2](t.ctx)).ok,true);
  assert.equal(t.dados.archived,0);
  assert.equal((await t.list[2]()).length,1);
});

test('API pública não lista campanhas arquivadas; migração 3 adiciona coluna',()=>{
  const rifas=fs.readFileSync(path.join(__dirname,'../src/rifas.js'),'utf8');
  const db=fs.readFileSync(path.join(__dirname,'../src/db.js'),'utf8');
  assert.match(rifas,/FROM campaigns WHERE archived=0 ORDER BY id/);
  assert.match(db,/ALTER TABLE campaigns ADD COLUMN archived INTEGER NOT NULL DEFAULT 0/);
});
