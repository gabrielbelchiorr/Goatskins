/* Arquivos públicos, cache, compressão, SEO e proteção do banco em desenvolvimento.
   Servidor real com banco FALSO (tests/helpers/pg-falso.js); nenhuma rede externa. */
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), http = require('node:http'), zlib = require('node:zlib');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');
const RAIZ = path.join(__dirname, '..'), DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-estatico-'));
const ENV = { ...require('./helpers/ambiente-teste'), TESTE: '1', DATA_DIR: DATA, PG_POOL_MAX: '1', FALHAR_PING: '' };
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ, 'public', f))).digest('base64url').slice(0, 16);
let srv, BASE;

async function subir(extra = {}) {
  const port = await freePort(), base = 'http://127.0.0.1:' + port;
  const p = spawn(process.execPath, ['--no-warnings', '-r', './tests/helpers/pg-falso.js', 'server.js'],
    { cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ENV, APP_URL: base, PORT: String(port), ...extra } });
  let log = ''; p.stdout.on('data', c => { log += c; }); p.stderr.on('data', c => { log += c; });
  const fim = Date.now() + 10000;
  while (Date.now() < fim && p.exitCode === null) {
    try { const r = await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) }); await r.arrayBuffer(); if (r.ok) return { p, base, log: () => log }; } catch (_) { /* aguardando */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (p.exitCode === null) p.kill();
  return { p, base, log: () => log, falhou: true };
}
const parar = p => p && p.exitCode === null ? new Promise(r => { p.once('close', r); p.kill(); }) : Promise.resolve();
/* Requisição crua: mostra os bytes comprimidos e os cabeçalhos exatamente como saem do servidor. */
const bruto = (url, headers = {}) => new Promise((ok, falha) => {
  http.get(url, { headers }, res => { const partes = []; res.on('data', c => partes.push(c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(partes) })); }).on('error', falha);
});

test.before(async () => { const s = await subir(); assert.ok(!s.falhou, s.log()); srv = s.p; BASE = s.base; });
test.after(async () => { await parar(srv); fs.rmSync(DATA, { recursive: true, force: true }); });

test('HTML: versões por hash do conteúdo, bloco SEO absoluto e dados estruturados', async () => {
  const r = await fetch(BASE + '/'), html = await r.text();
  assert.equal(r.headers.get('cache-control'), 'no-cache'); assert.match(r.headers.get('etag'), /^"[\w-]{16}"$/);
  for (const f of ['style.css', 'script.js', 'page-loader.js'])
    assert.ok(html.includes(f + '?v=' + hash(f) + '"'), f + ' deve receber o hash atual');
  assert.doesNotMatch(html, /\?v=goatskins|\?v=cs2inspect|\?v=ptbr/, 'versões manuais antigas não podem sobrar');
  assert.ok(html.includes('<link rel="canonical" href="' + BASE + '/">'));
  assert.ok(html.includes('<meta property="og:image" content="' + BASE + '/og-image.jpg">'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
  assert.equal(ld['@graph'][0].url, BASE + '/');
  assert.equal((html.match(/<title>/g) || []).length, 1);
  // Páginas legais também recebem título/descrição/canonical próprios.
  const termos = await (await fetch(BASE + '/termos.html')).text();
  assert.ok(termos.includes('<link rel="canonical" href="' + BASE + '/termos.html">'));
  assert.match(termos, /<meta name="description" content="Regras de participação/);
  assert.ok(termos.includes('style.css?v=' + hash('style.css')));
});

test('folha de estilo única em todas as páginas; CSS antigos não são mais servidos', async () => {
  for (const u of ['/', '/termos.html', '/privacidade.html', '/cookies.html']) {
    const html = await (await fetch(BASE + u)).text();
    assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)].map(m => m[1]), ['style.css'], u);
  }
  for (const f of ['premium.css', 'journey.css', 'roulette.css', 'skin-viewer.css', 'presets.css'])
    assert.equal((await fetch(BASE + '/' + f)).status, 404, f);
});

test('compressão br/gzip com Vary e corpo idêntico ao arquivo', async () => {
  const original = fs.readFileSync(path.join(RAIZ, 'public/script.js'));
  const br = await bruto(BASE + '/script.js', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br'); assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), original); assert.ok(br.body.length < original.length / 2);
  const gz = await bruto(BASE + '/script.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.deepEqual(zlib.gunzipSync(gz.body), original);
  const id = await bruto(BASE + '/script.js');
  assert.equal(id.headers['content-encoding'], undefined); assert.deepEqual(id.body, original);
  const img = await bruto(BASE + '/logo-nav.webp', { 'Accept-Encoding': 'br' });
  assert.equal(img.headers['content-encoding'], undefined, 'imagens não são recomprimidas');
  assert.equal(img.headers['cache-control'], 'public, max-age=86400');
});

test('ETag/304 e cache longo somente para a URL com o hash atual', async () => {
  const v = hash('style.css');
  const atual = await fetch(BASE + '/style.css?v=' + v);
  assert.equal(atual.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  for (const u of ['/style.css', '/style.css?v=antigo']) assert.equal((await fetch(BASE + u)).headers.get('cache-control'), 'no-cache', u);
  const etag = atual.headers.get('etag'); await atual.arrayBuffer();
  const r304 = await bruto(BASE + '/style.css', { 'If-None-Match': 'W/' + etag });
  assert.equal(r304.status, 304); assert.equal(r304.body.length, 0); assert.equal(r304.headers['x-content-type-options'], 'nosniff');
  assert.equal((await bruto(BASE + '/style.css', { 'If-None-Match': '"outro"' })).status, 200);
  const fonte = await fetch(BASE + '/fonts/barlow-regular.woff2');
  assert.equal(fonte.headers.get('cache-control'), 'public, max-age=2592000'); assert.equal(fonte.headers.get('content-type'), 'font/woff2');
  const head = await fetch(BASE + '/script.js', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('robots.txt, sitemap.xml, favicon e manifest', async () => {
  const robots = await (await fetch(BASE + '/robots.txt')).text();
  assert.match(robots, /Disallow: \/api\//); assert.match(robots, /Allow: \/api\/campanhas\//);
  assert.ok(robots.includes('Sitemap: ' + BASE + '/sitemap.xml'));
  const sm = await fetch(BASE + '/sitemap.xml'), xml = await sm.text();
  assert.match(sm.headers.get('content-type'), /application\/xml/);
  for (const u of ['/', '/termos.html', '/privacidade.html', '/cookies.html']) assert.ok(xml.includes('<loc>' + BASE + u + '</loc>'), u);
  const ico = await fetch(BASE + '/favicon.ico');
  assert.equal(ico.status, 200); assert.equal(ico.headers.get('content-type'), 'image/png');
  const mf = await fetch(BASE + '/site.webmanifest');
  assert.match(mf.headers.get('content-type'), /manifest\+json/); assert.equal((await mf.json()).short_name, 'GOATSKINS');
  for (const f of ['og-image.jpg', 'apple-touch-icon.png', 'favicon-48.png']) assert.equal((await fetch(BASE + '/' + f)).status, 200, f);
  assert.equal((await fetch(BASE + '/prova.js')).status, 404, 'a prova não é publicada na interface');
});

test('sorteio inexistente ou banco indisponível mantém os metadados padrão', async () => {
  const html = await (await fetch(BASE + '/?sorteio=999999')).text();
  assert.ok(html.includes('<link rel="canonical" href="' + BASE + '/">'));
  for (const q of ['?sorteio=abc', '?sorteio=-1', '?sorteio=1e3']) assert.equal((await fetch(BASE + '/' + q)).status, 200, q);
});

test('a allowlist continua fechada para arquivos e caminhos não publicados', async () => {
  for (const u of ['/.env', '/server.js', '/src/estatico.js', '/public/index.html', '/fonts/OFL-Barlow.txt', '/%2e%2e/server.js'])
    assert.ok([400, 403, 404].includes((await fetch(BASE + u)).status), u);
});

test('metadados do sorteio: texto do banco é escapado e não cria tags', () => {
  require('./helpers/ambiente-teste');
  const est = require('../src/estatico');
  const c = { id: 7, premio: 'AK"><script>alert(1)</script>', desgaste: "Field' & co", preco_centavos: 250, max: 10, total: 4, status: 'OPEN', vencedor: null, fl: 1234 };
  const bloco = est._blocoSeo(est._metadados(est.PAGINAS['index.html'], c), false);
  assert.doesNotMatch(bloco, /<script>|"><script/);
  assert.match(bloco, /AK&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(bloco, /Field&#39; &amp; co/);
  assert.match(bloco, /R\$ 2,50 por número\. 6 de 10 números disponíveis\./);
  assert.match(bloco, /\/api\/campanhas\/7\/foto\?v=1234/);
  assert.match(bloco, /\?sorteio=7/);
  const realizado = est._blocoSeo(est._metadados(est.PAGINAS['index.html'], { ...c, vencedor: 3, fl: 0 }), false);
  assert.match(realizado, /Sorteio realizado/); assert.match(realizado, /og-image\.jpg/);
  const ld = est._blocoSeo(est._metadados(est.PAGINAS['index.html'], null), true);
  assert.doesNotMatch(ld.match(/ld\+json">([\s\S]*?)<\/script>/)[1], /</, 'JSON-LD não pode conter "<" literal');
});

test('servidor de desenvolvimento recusa banco remoto sem opt-in explícito', async () => {
  const remoto = { DATABASE_URL: 'postgresql://fixture:fixture@db-remoto.example.invalid/goatskins' };
  const bloqueado = await subir(remoto);
  assert.ok(bloqueado.falhou); assert.equal(bloqueado.p.exitCode, 1);
  assert.match(bloqueado.log(), /banco remoto \(db-remoto\.example\.invalid\)/); assert.doesNotMatch(bloqueado.log(), /fixture:fixture/);
  const permitido = await subir({ ...remoto, PERMITIR_BANCO_REMOTO: '1' });
  try { assert.ok(!permitido.falhou, permitido.log()); assert.match(permitido.log(), /ATENÇÃO/); }
  finally { await parar(permitido.p); }
});
