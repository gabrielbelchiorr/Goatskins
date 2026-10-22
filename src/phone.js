const { db, tx, agora } = require('./db');
const { Erro } = require('./http');
const DDDS = new Set('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '));
function normalize(value) {
  if (typeof value !== 'string' || value.length > 25 || !/^[+\d ()-]+$/.test(value)) throw new Erro('Informe um celular brasileiro válido com DDD.');
  let n = value.replace(/\D/g, '');
  if (value.includes('+') && (!/^\+55[\d ()-]+$/.test(value) || n.length !== 13))
    throw new Erro('Informe um celular brasileiro válido com DDD.');
  if (n.length === 13 && n.startsWith('55')) n = n.slice(2);
  if (!/^\d{2}9\d{8}$/.test(n) || !DDDS.has(n.slice(0, 2))) throw new Erro('Informe um celular brasileiro válido com DDD.');
  return '+55' + n;
}

function valid(value) { try { normalize(value); return true; } catch (_) { return false; } }
function exigir(user) {
  if (!user.email_verificado || !user.celular_preenchido)
    throw new Erro('Confirme seu e-mail e preencha um celular válido com DDD para participar.',403);
}
async function status(ctx) {
  const u=await db.get('SELECT celular,telefone FROM users WHERE id=?',[ctx.user.id]);
  const number=valid(u.celular) ? u.celular : valid(u.telefone) ? u.telefone : null;
  return {celular: number ? normalize(number) : null, preenchido: !!number};
}
async function save(ctx) {
  const number=normalize(ctx.body.telefone);
  await tx(async()=>{
    await db.run('UPDATE users SET celular_verificado=CASE WHEN celular=? THEN celular_verificado ELSE 0 END, celular=?,telefone=?,atualizado_em=? WHERE id=?',[number,number,number,agora(),ctx.user.id]);
    await db.run('DELETE FROM phone_verifications WHERE user_id=?',[ctx.user.id]);
  });
  return {ok:true,celular:number,preenchido:true};
}
module.exports={normalize,valid,exigir,status,save,rotas:[
  ['GET', /^\/api\/celular$/,status,'user'],
  ['POST', /^\/api\/celular$/,save,'user']
]};
