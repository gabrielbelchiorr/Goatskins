/* Biblioteca administrativa: somente configurações, nunca estado de uma campanha.
   Cada criação de campanha continua gerando seu próprio ID, semente e compromisso. */
const { db, tx, agora, audit } = require('./db');
const { Erro, txt, inteiro } = require('./http');
const { corpoCampanha, configuracao3d, imagem } = require('./rifas');

const CAMPOS = Object.freeze(['premio', 'desgaste', 'descricao', 'valor', 'cor', 'max', 'max_por_usuario', 'preco_numero', 'foto', 'viewer_3d', 'reconfigurar_3d']);
const COLUNAS = 'id,nome,dados,versao,criado_em,atualizado_em,viewer_3d_pendente';
function projetar(p) {
  // Snapshots antigos permanecem intactos no banco. A projeção atual elimina
  // os campos exclusivos do provedor anterior sem adivinhar float/padrão/item.
  const raw = p.dados || {};
  const dados = Object.fromEntries(CAMPOS.filter(campo => Object.hasOwn(raw, campo)).map(campo => [campo, raw[campo]]));
  Object.assign(dados, configuracao3d({...raw, viewer_3d_pendente:p.viewer_3d_pendente}));
  const { viewer_3d_pendente, ...publico } = p;
  return {...publico, dados, reconfigurar_3d:dados.reconfigurar_3d};
}
function validarDados(entrada) {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) throw new Erro('Informe os dados da predefinição.');
  if (Object.keys(entrada).some(campo => !CAMPOS.includes(campo))) throw new Erro('A predefinição aceita somente os campos configuráveis do sorteio.');
  for (const campo of ['premio', 'desgaste', 'descricao', 'cor', 'foto'])
    if (entrada[campo] !== undefined && typeof entrada[campo] !== 'string') throw new Erro('Campo inválido na predefinição: ' + campo + '.');
  if (entrada.cor !== undefined && !/^#[a-f0-9]{6}$/i.test(entrada.cor)) throw new Erro('Cor inválida.');
  if (entrada.max_por_usuario !== undefined) inteiro(entrada.max_por_usuario, 1, Number(entrada.max), 'Limite por pessoa inválido.');
  const d = corpoCampanha(entrada, false);
  // Allowlist explícita também na saída: impede que novos campos operacionais
  // adicionados ao validador de campanhas sejam copiados por acidente.
  return { premio: d.premio, desgaste: d.desgaste, descricao: d.descricao, valor: d.valor,
    cor: d.cor, max: d.max, max_por_usuario: d.max_por_usuario, preco_numero: d.preco_centavos / 100,
    foto: d.foto, viewer_3d: d.viewer_3d, reconfigurar_3d: d.viewer_3d_pendente === 1 };
}
const versao = valor => inteiro(valor, 1, 2147483646, 'Recarregue a predefinição para confirmar sua versão.');
async function buscar(id) {
  const p = await db.get('SELECT ' + COLUNAS + ' FROM campaign_presets WHERE id=?', [id]);
  if (!p) throw new Erro('Predefinição não encontrada.', 404);
  return projetar(p);
}
function conferirVersao(p, valor) {
  if (p.versao !== versao(valor)) throw new Erro('Esta predefinição foi alterada por outro administrador. Recarregue os dados antes de continuar.', 409);
}
async function inserir(nome, dados, ctx, acao) {
  const quando = agora();
  const id = await db.insert('INSERT INTO campaign_presets(nome,dados,criado_por,atualizado_por,criado_em,atualizado_em,viewer_3d_pendente) VALUES(?,?::jsonb,?,?,?,?,?)',
    [nome, JSON.stringify(dados), ctx.user.id, ctx.user.id, quando, quando, dados.reconfigurar_3d ? 1 : 0]);
  await audit(ctx.user.id, acao, 'predefinição ' + id + ': ' + nome, ctx.ip);
  return buscar(id);
}
const rotas = [
  ['GET', /^\/api\/admin\/predefinicoes$/, async ctx => {
    const q = txt(ctx.query.q || '', 120);
    const lista = await db.all(`SELECT id,nome,dados - 'foto' AS dados,versao,criado_em,atualizado_em,viewer_3d_pendente,
      length(COALESCE(dados->>'foto','')) AS foto_tamanho FROM campaign_presets
      WHERE position(lower(?) in lower(nome))>0 OR position(lower(?) in lower(dados->>'premio'))>0
      ORDER BY lower(nome),id`, [q, q]);
    return lista.map(({ foto_tamanho, ...p }) => ({ ...projetar(p), foto: foto_tamanho ? '/api/admin/predefinicoes/' + p.id + '/foto?v=' + p.versao : '' }));
  }, 'admin'],
  ['GET', /^\/api\/admin\/predefinicoes\/(\d+)\/foto$/, async ctx => {
    const p = await db.get("SELECT dados->>'foto' AS foto FROM campaign_presets WHERE id=?", [Number(ctx.params[0])]);
    return imagem(p?.foto);
  }, 'admin'],
  ['GET', /^\/api\/admin\/predefinicoes\/(\d+)$/, ctx => buscar(Number(ctx.params[0])), 'admin'],
  ['POST', /^\/api\/admin\/predefinicoes$/, async ctx => {
    const nome = txt(ctx.body.nome, 120, 1), dados = validarDados(ctx.body.dados);
    return tx(() => inserir(nome, dados, ctx, 'PREDEFINICAO_CRIADA'));
  }, 'admin'],
  ['PUT', /^\/api\/admin\/predefinicoes\/(\d+)$/, async ctx => {
    const id = Number(ctx.params[0]), nome = txt(ctx.body.nome, 120, 1), dados = validarDados(ctx.body.dados);
    return tx(async () => {
      const p = await buscar(id); conferirVersao(p, ctx.body.versao);
      await db.run('UPDATE campaign_presets SET nome=?,dados=?::jsonb,viewer_3d_pendente=?,versao=versao+1,atualizado_por=?,atualizado_em=? WHERE id=?',
        [nome, JSON.stringify(dados), dados.reconfigurar_3d ? 1 : 0, ctx.user.id, agora(), id]);
      await audit(ctx.user.id, 'PREDEFINICAO_EDITADA', 'predefinição ' + id, ctx.ip);
      return buscar(id);
    });
  }, 'admin'],
  ['POST', /^\/api\/admin\/predefinicoes\/(\d+)\/duplicar$/, ctx => tx(async () => {
    const p = await buscar(Number(ctx.params[0]));
    const nome = ctx.body.nome === undefined ? p.nome.slice(0, 112) + ' — cópia' : txt(ctx.body.nome, 120, 1);
    return inserir(nome, validarDados(p.dados), ctx, 'PREDEFINICAO_DUPLICADA');
  }), 'admin'],
  ['DELETE', /^\/api\/admin\/predefinicoes\/(\d+)$/, ctx => tx(async () => {
    const p = await buscar(Number(ctx.params[0])); conferirVersao(p, ctx.body.versao);
    await db.run('DELETE FROM campaign_presets WHERE id=?', [p.id]);
    await audit(ctx.user.id, 'PREDEFINICAO_EXCLUIDA', 'predefinição ' + p.id + ': ' + p.nome, ctx.ip);
    return { ok: true };
  }), 'admin']
];
module.exports = { rotas, validarDados, CAMPOS };
