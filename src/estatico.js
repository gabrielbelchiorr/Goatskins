/* Arquivos públicos e metadados de compartilhamento.
   - Cada arquivo da allowlist fica em memória com hash do conteúdo (ETag) e versões br/gzip.
   - O HTML recebe ?v=<hash> nos CSS/JS locais: quando o conteúdo muda, a URL muda.
     Somente a URL com o hash atual recebe cache longo; qualquer outra revalida.
   - O bloco <!-- seo:inicio --> ... <!-- seo:fim --> é regenerado com a URL canônica (APP_URL).
     Em /?sorteio=ID, os metadados descrevem o sorteio (WhatsApp/Instagram não executam JS).
   Nenhum dado privado entra nos metadados: só campos já públicos em /api/estado. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { promisify } = require('node:util');
const cfg = require('./config');

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
const COMPRIMIVEL = new Set(['.html', '.css', '.js', '.webmanifest', '.txt', '.xml']);
const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
const PUB = path.join(cfg.raiz, 'public');
const cache = new Map();
const hashDe = b => crypto.createHash('sha256').update(b).digest('base64url').slice(0, 16);
const escapar = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const origem = () => cfg.APP_URL.replace(/\/$/, '');

/* Lê (ou reaproveita) um arquivo público. Recarrega quando data/tamanho mudam. Recusa symlinks. */
async function entrada(nome) {
  const arquivo = path.join(PUB, nome);
  const st = await fs.promises.lstat(arquivo);
  if (st.isSymbolicLink()) { const e = new Error('symlink'); e.status = 403; throw e; }
  if (!st.isFile()) { const e = new Error('não é arquivo'); e.status = 404; throw e; }
  const atual = cache.get(nome);
  if (atual && atual.mtimeMs === st.mtimeMs && atual.size === st.size) return atual;
  const data = await fs.promises.readFile(arquivo);
  const e = { nome, ext: path.extname(nome).toLowerCase(), mtimeMs: st.mtimeMs, size: st.size, data, hash: hashDe(data) };
  cache.set(nome, e); return e;
}
async function comprimido(e, tipo) {
  const chave = '_' + tipo;
  if (!e[chave]) e[chave] = tipo === 'br'
    ? brotli(e.data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: e.data.length } })
    : gzip(e.data, { level: 9 });
  return e[chave];
}
function codificacao(req, ext) {
  if (!COMPRIMIVEL.has(ext)) return '';
  const ae = String(req.headers['accept-encoding'] || '');
  return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : '';
}
function politicaCache(e, versao) {
  if (e.ext === '.html') return 'no-cache';
  if (versao && versao === e.hash) return 'public, max-age=31536000, immutable';
  if (e.ext === '.woff2') return 'public, max-age=2592000';
  if (['.webp', '.jpg', '.png', '.ico'].includes(e.ext)) return 'public, max-age=86400';
  if (e.ext === '.webmanifest') return 'public, max-age=86400';
  return 'no-cache'; // CSS/JS sem o hash atual sempre revalidam (ETag)
}
const naoModificado = (req, etag) => String(req.headers['if-none-match'] || '').split(',')
  .some(t => t.trim().replace(/^W\//, '') === etag);

/* Envia um corpo já pronto, com ETag/304 e compressão. */
async function enviar(req, res, { corpo, ext, tipo, cacheControl, hash, e }) {
  const etag = '"' + hash + '"', enc = codificacao(req, ext);
  const cab = { 'Content-Type': tipo || TIPOS[ext], 'Cache-Control': cacheControl, ETag: etag };
  if (COMPRIMIVEL.has(ext)) cab.Vary = 'Accept-Encoding';
  if (naoModificado(req, etag)) { res.writeHead(304, cab); return res.end(); }
  let saida = corpo;
  if (enc) {
    saida = e ? await comprimido(e, enc) : enc === 'br' ? await brotli(corpo) : await gzip(corpo);
    cab['Content-Encoding'] = enc;
  }
  cab['Content-Length'] = saida.length;
  res.writeHead(200, cab);
  res.end(req.method === 'HEAD' ? undefined : saida);
}

/* ---------- SEO ---------- */
const PAGINAS = {
  'index.html': { caminho: '/', titulo: 'GOATSKINS — Sorteios de skins de CS2',
    descricao: 'Sorteios de skins de CS2 com números escolhidos por você, pagamento por Pix e resultado publicado no site.' },
  'termos.html': { caminho: '/termos.html', titulo: 'Termos de uso | GOATSKINS', descricao: 'Regras de participação, pagamento, reserva e reembolso dos sorteios GOATSKINS.' },
  'privacidade.html': { caminho: '/privacidade.html', titulo: 'Política de privacidade | GOATSKINS', descricao: 'Como a GOATSKINS coleta, usa e protege os seus dados.' },
  'cookies.html': { caminho: '/cookies.html', titulo: 'Política de cookies | GOATSKINS', descricao: 'Cookies e armazenamento local usados pela GOATSKINS e como gerenciar suas preferências.' }
};
const brl = c => 'R$ ' + (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function campanhaPublica(id) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  try {
    const { db } = require('./db');
    const c = await db.get(`SELECT c.id, c.premio, c.desgaste, c.preco_centavos, c.max, c.status, length(c.foto) fl,
      (SELECT COUNT(*) FROM tickets t WHERE t.campaign_id=c.id) total, (SELECT n FROM winners w WHERE w.campaign_id=c.id) vencedor
      FROM campaigns c WHERE c.id=? AND c.archived=0`, [id]);
    return c && Number(c.id) === id && typeof c.premio === 'string' ? c : null;
  } catch (_) { return null; } // metadados nunca derrubam a página
}
function metadados(pagina, c) {
  const base = origem();
  const m = { titulo: pagina.titulo, descricao: pagina.descricao, url: base + pagina.caminho,
    imagem: base + '/og-image.jpg', imagemLargura: 1200, imagemAltura: 630, imagemAlt: 'GOATSKINS — sorteios de skins de CS2', tipo: 'website' };
  if (c) {
    const nome = c.premio + (c.desgaste ? ' (' + c.desgaste + ')' : '');
    const preco = c.preco_centavos > 0 ? brl(c.preco_centavos) + ' por número' : 'participação gratuita';
    const situacao = c.vencedor != null ? 'Sorteio realizado — veja o resultado.'
      : c.status !== 'OPEN' || c.total >= c.max ? 'Números esgotados — aguardando o sorteio.'
      : (c.max - c.total) + ' de ' + c.max + ' números disponíveis.';
    Object.assign(m, { titulo: 'Sorteio: ' + c.premio + ' | GOATSKINS', descricao: nome + ' · ' + preco + '. ' + situacao,
      url: base + '/?sorteio=' + c.id, imagemAlt: c.premio });
    if (c.fl) Object.assign(m, { imagem: base + '/api/campanhas/' + c.id + '/foto?v=' + c.fl, imagemLargura: 0, imagemAltura: 0 });
  }
  return m;
}
function blocoSeo(m, inicial) {
  const meta = (k, v, attr = 'property') => '<meta ' + attr + '="' + k + '" content="' + escapar(v) + '">';
  const linhas = [
    '<title>' + escapar(m.titulo) + '</title>',
    meta('description', m.descricao, 'name'),
    '<link rel="canonical" href="' + escapar(m.url) + '">',
    meta('og:type', m.tipo), meta('og:site_name', 'GOATSKINS'), meta('og:locale', 'pt_BR'),
    meta('og:title', m.titulo), meta('og:description', m.descricao), meta('og:url', m.url),
    meta('og:image', m.imagem), meta('og:image:alt', m.imagemAlt),
    ...(m.imagemLargura ? [meta('og:image:width', String(m.imagemLargura)), meta('og:image:height', String(m.imagemAltura))] : []),
    meta('twitter:card', 'summary_large_image', 'name'), meta('twitter:title', m.titulo, 'name'),
    meta('twitter:description', m.descricao, 'name'), meta('twitter:image', m.imagem, 'name')
  ];
  if (inicial) {
    // Dados estruturados da marca. "<" é escapado para não encerrar o <script>.
    const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'Organization', name: 'GOATSKINS', url: origem() + '/', logo: origem() + '/apple-touch-icon.png', email: 'ggoatskins@gmail.com' },
      { '@type': 'WebSite', name: 'GOATSKINS', url: origem() + '/', inLanguage: 'pt-BR' }] }).replace(/</g, '\\u003c');
    linhas.push('<script type="application/ld+json">' + ld + '</script>');
  }
  return '<!-- seo:inicio -->\n  ' + linhas.join('\n  ') + '\n  <!-- seo:fim -->';
}

/* Versões por conteúdo: style.css?v=<hash>. */
const RE_ASSET = /(\s(?:href|src)=")([a-z0-9][a-z0-9\-/]*\.(?:css|js))(?:\?v=[^"]*)?"/gi;
async function versionar(html, publicos) {
  const nomes = [...new Set([...html.matchAll(RE_ASSET)].map(m => m[2]).filter(n => publicos.has(n)))];
  const hashes = new Map();
  for (const n of nomes) { try { hashes.set(n, (await entrada(n)).hash); } catch (_) { /* referência inexistente: mantém */ } }
  return html.replace(RE_ASSET, (todo, pre, nome) => hashes.has(nome) ? pre + nome + '?v=' + hashes.get(nome) + '"' : todo);
}
async function servirHtml(req, res, e, url, publicos) {
  const pagina = PAGINAS[e.nome];
  const sorteio = e.nome === 'index.html' ? Number(url.searchParams.get('sorteio')) : NaN;
  const c = Number.isSafeInteger(sorteio) && sorteio > 0 ? await campanhaPublica(sorteio) : null;
  let html = await versionar(e.data.toString('utf8'), publicos);
  if (pagina) html = html.replace(/<!-- seo:inicio -->[\s\S]*?<!-- seo:fim -->/, () => blocoSeo(metadados(pagina, c), e.nome === 'index.html'));
  const corpo = Buffer.from(html, 'utf8');
  // O HTML é pequeno; compressão por requisição evita guardar uma variante por sorteio.
  return enviar(req, res, { corpo, ext: '.html', cacheControl: 'no-cache', hash: hashDe(corpo) });
}

/* Arquivo da allowlist (o chamador já validou nome e caminho). */
async function servir(req, res, nome, url, publicos) {
  let e;
  try { e = await entrada(nome); }
  catch (err) { res.writeHead(err.status || 404, { 'Cache-Control': 'no-store' }); return res.end(err.status === 403 ? undefined : 'Não encontrado'); }
  if (e.ext === '.html') return servirHtml(req, res, e, url, publicos);
  return enviar(req, res, { corpo: e.data, ext: e.ext, cacheControl: politicaCache(e, url.searchParams.get('v')), hash: e.hash, e });
}

/* Rotas geradas: robots.txt, sitemap.xml e /favicon.ico. Retorna false se não for uma delas. */
async function especial(req, res, rota, url, publicos) {
  if (rota === '/favicon.ico') return servir(req, res, 'favicon-48.png', url, publicos).then(() => true);
  if (rota === '/robots.txt') {
    // A foto pública do sorteio é a imagem de compartilhamento; o restante da API não deve ser indexado.
    const txt = 'User-agent: *\nAllow: /\nAllow: /api/campanhas/\nAllow: /api/banner\nDisallow: /api/\n\nSitemap: ' + origem() + '/sitemap.xml\n';
    const corpo = Buffer.from(txt);
    await enviar(req, res, { corpo, ext: '.txt', cacheControl: 'public, max-age=3600', hash: hashDe(corpo) });
    return true;
  }
  if (rota === '/sitemap.xml') {
    let ids = [];
    try { ids = (await require('./db').db.all("SELECT id FROM campaigns WHERE archived=0 AND status<>'DRAWN' ORDER BY id DESC LIMIT 500")).map(r => r.id); }
    catch (_) { /* sem banco: só as páginas fixas */ }
    const urls = ['/', '/termos.html', '/privacidade.html', '/cookies.html', ...ids.map(id => '/?sorteio=' + id)];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map(u => '  <url><loc>' + escapar(origem() + u) + '</loc></url>').join('\n') + '\n</urlset>\n';
    const corpo = Buffer.from(xml);
    await enviar(req, res, { corpo, ext: '.xml', cacheControl: 'public, max-age=3600', hash: hashDe(corpo) });
    return true;
  }
  return false;
}
module.exports = { servir, especial, TIPOS, _blocoSeo: blocoSeo, _metadados: metadados, _versionar: versionar, PAGINAS };
