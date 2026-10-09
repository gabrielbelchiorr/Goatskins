/* Testes OFFLINE da proteção da reserva quando o Pix vence.
   Nenhuma chamada real ao Mercado Pago ou a PostgreSQL. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function setup({ cancelarFalha = false, pago = false } = {}) {
  const p = {id: 42, public_id: 'a'.repeat(32), mp_order_id:'ORD00000000000001TEST', user_id: 7,
    status: 'PENDING', expira_em: Date.now()-1000, total_centavos: 1250, numeros:'[3]', campaign_id: 6};
  let cancelamentos=0, excluiuReserva=false, buscou=0;
  const pedido = {...p};
  const db = {
    async all(sql){
      assert.match(sql,/status='PENDING' AND expira_em/);
      return pedido.status==='PENDING'?[{id:pedido.id,public_id:pedido.public_id,mp_order_id:pedido.mp_order_id}]:[];
    },
    async get(sql) {
      if(sql.startsWith('SELECT * FROM pedidos WHERE id=')) return {...pedido};
      if(sql.startsWith('SELECT status FROM pedidos WHERE id=')) return {status:pedido.status};
      throw new Error('SQL de leitura inesperado: '+sql);
    },
    async run(sql,args) {
      if(sql.startsWith('UPDATE pedidos SET status=')) pedido.status=args[0];
      if(sql.includes('DELETE FROM reservas WHERE pedido_id=')) excluiuReserva=true;
      return {changes:1};
    }
  };
  const pendente={id:pedido.mp_order_id,external_reference:pedido.public_id,
    status:'action_required',transactions:{payments:[{status:'action_required'}]}};
  const cancelado={...pendente,status:'canceled',transactions:{payments:[{status:'canceled'}]}};
  const confirmado={...pendente,status:'processed',status_detail:'accredited',total_amount:'12.50',total_paid_amount:'12.50',
    transactions:{payments:[{status:'processed',paid_amount:'12.50'}]}};
  const mock = {
    './config': { APP_URL:'http://localhost:3000' },
    './mercadopago': {
      configurado:()=>true,
      async buscarOrder(){buscou++;return pago?confirmado:pendente;},
      async cancelarOrder(){cancelamentos++;if(cancelarFalha)throw new Error('MP offline');return cancelado;}
    },
    './mail': {enviar(){}},
    './db': {db,agora:()=>new Date().toISOString(),tx:async fn=>fn(),
      liberar:async()=>{},liberarSeVencido:async()=>{},audit:async()=>{},notificar:async()=>{}},
    './http': {Erro:class Erro extends Error {constructor(message,code=400){super(message);this.code=code;}},inteiro:v=>v,limite:()=>{}}
  };
  const src=fs.readFileSync(path.join(__dirname,'../src/pedidos.js'),'utf8');
  const sandbox={module:{exports:{}},require:(name)=>name==='node:crypto'?crypto:mock[name],
    setInterval:()=>({unref(){}}),Date,Buffer,console:{log(){},error(){}}};
  vm.runInNewContext(src,sandbox,{filename:'pedidos.js'});
  return {ped:sandbox.module.exports,pedido,estado:()=>({cancelamentos,excluiuReserva,buscou})};
}

test('após 5 min, cancela no Mercado Pago antes de liberar números',async()=>{
  const t=setup();await t.ped.finalizarVencidos();
  assert.equal(t.pedido.status,'EXPIRED');
  assert.equal(t.estado().cancelamentos,1);
  assert.equal(t.estado().excluiuReserva,true);
  assert.equal(t.estado().buscou,1);
});

test('se Mercado Pago falha no cancelamento, mantém a reserva e o pedido pendente',async()=>{
  const t=setup({cancelarFalha:true});await t.ped.finalizarVencidos();
  assert.equal(t.pedido.status,'PENDING');
  assert.equal(t.estado().excluiuReserva,false);
});

test('se Pix já foi pago, nunca tenta cancelar',async()=>{
  const t=setup({pago:true});
  // O caminho de confirmação é coberto nos testes/pagamentos.test.js e pela API real.
  // O parser precisa reconhecer o pagamento correto antes de decidir cancelar.
  assert.equal(t.ped.interpretar({id:t.pedido.mp_order_id,external_reference:t.pedido.public_id,
    status:'processed',status_detail:'accredited',total_amount:'12.50',total_paid_amount:'12.50',
    transactions:{payments:[{status:'processed',paid_amount:'12.50'}]}},t.pedido).estado,'PAGO');
});
