/* HTTP boundary regression tests. All traffic stays on loopback; PostgreSQL is
   replaced by the existing stub. These tests do not prove database invariants
   or the behavior of the Render reverse proxy. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const root = path.join(__dirname, '..');
let child, port, base;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const result = server.address().port;
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return result;
}

async function stop() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

before(async () => {
  port = await freePort(); base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['--no-warnings', '-r', './tests/helpers/pg-falso.js', 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_ENV: 'test', RENDER: '', TESTE: '1', PORT: String(port), APP_URL: base,
      DATABASE_URL: 'postgresql://fixture:fixture@localhost/goatskins_test', DATABASE_SSL: '0', DATABASE_CA: '', PG_POOL_MAX: '1',
      EMAIL_DRIVER: 'console', EMAIL_API_KEY: '', EMAIL_FROM: 'GOATSKINS <no-reply@goatskins.test>', EMAIL_CODE_SECRET: 'a'.repeat(64),
      TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '', TURNSTILE_HOSTNAMES: '', ORIGIN_VERIFY_SECRET: '',
      TRUST_PROXY: '0', TRUST_PROXY_HOPS: '1', MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '', MP_TESTE_APRO: '',
      MP_API_BASE: 'https://api.mercadopago.com', PIX_MINUTOS: '30', RESERVA_SEGUNDOS: '', FALHAR_PING: ''
    }
  });
  let logs = '', processError;
  const collect = chunk => { logs = (logs + chunk.toString()).slice(-2000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.once('error', e => { processError = e; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !processError && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(300) });
      await response.arrayBuffer(); if (response.status === 200) return;
    } catch (_) { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await stop();
  throw new Error('HTTP audit fixture did not start: ' + (processError?.message || logs));
});
after(stop);

function raw(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '', settled = false;
    const timer = setTimeout(() => { socket.destroy(); finish(new Error('Local HTTP request timed out')); }, 5000);
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(response);
    }
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('error', error => response ? finish() : finish(error));
    socket.on('close', () => finish());
  });
}

async function healthy() {
  const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200); assert.equal(await response.text(), 'ok');
}

const jsonHeaders = { 'Content-Type': 'application/json', 'X-Requested-With': 'goatskins' };
test('streaming chunked body is rejected before the client finishes uploading', async () => {
  let ended = false;
  const result = await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/absent', {
      method: 'POST', headers: { ...jsonHeaders, 'Transfer-Encoding': 'chunked' }
    });
    const timer = setTimeout(() => { request.destroy(); reject(new Error('No streaming size rejection')); }, 4000);
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString(), ended });
        request.destroy();
      });
    });
    // Deliberately leave the last chunk and the request unfinished.
    request.write(Buffer.alloc(60000, 120));
    request.write(Buffer.alloc(40001, 120));
  });
  assert.equal(result.status, 413); assert.equal(result.ended, false);
  assert.equal(result.headers.connection, 'close'); assert.match(result.body, /grande demais/);
  await healthy();
});

test('body budget counts UTF-8 bytes and includes the exact boundary', async () => {
  const atLimit = JSON.stringify({ value: 'á'.repeat(49994) });
  assert.equal(Buffer.byteLength(atLimit), 100000);
  for (const [body, status] of [[atLimit, 404], [atLimit + ' ', 413]]) {
    const response = await fetch(base + '/api/absent', { method: 'POST', headers: jsonHeaders, body });
    assert.equal(response.status, status); await response.arrayBuffer();
  }
  await healthy();
});

test('malformed chunk framing is rejected and cannot dispatch a pipelined request', async () => {
  const response = await raw('POST /api/absent HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nZZ\r\nGET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n');
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.equal((response.match(/HTTP\/1\.1 /g) || []).length, 1);
  await healthy();
});

test('ambiguous message framing is rejected by the strict Node HTTP parser', async () => {
  for (const headers of [
    'Content-Length: 2\r\nContent-Length: 2',
    'Content-Length: 2\r\nContent-Length: 5',
    'Content-Length: 2\r\nTransfer-Encoding: chunked',
    'Transfer-Encoding: chunked, chunked',
    'Content-Length: +2'
  ]) {
    const response = await raw('POST /api/absent HTTP/1.1\r\nHost: localhost\r\n' + headers + '\r\nConnection: close\r\n\r\n{}GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 400 /, headers);
    assert.equal((response.match(/HTTP\/1\.1 /g) || []).length, 1, headers);
  }
  await healthy();
});

test('invalid header syntax and an oversized header fail without exposing implementation details', async () => {
  for (const [header, status] of [['Bad Header: value', 400], ['X-Value: bad\u0000value', 400], ['X-Large: ' + 'x'.repeat(20000), 431]]) {
    const response = await raw('GET /healthz HTTP/1.1\r\nHost: localhost\r\n' + header + '\r\nConnection: close\r\n\r\n');
    assert.match(response, new RegExp('^HTTP/1\\.1 ' + status + ' '));
    assert.doesNotMatch(response, /node_modules|SyntaxError|server\.js|HPE_/);
  }
  await healthy();
});

test('invalid JSON is rejected before route execution, including incomplete and concatenated documents', async () => {
  for (const body of ['{', '{"a":1,}', '{}{}', '{"a":"\u0000"}', 'null', '[]', 'true', '42', '"text"']) {
    const response = await fetch(base + '/api/absent', { method: 'POST', headers: jsonHeaders, body });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /SyntaxError|node_modules|server\.js|at \w+ \(/);
  }
  const response = await fetch(base + '/api/absent', {
    method: 'POST', headers: jsonHeaders, body: '{"__proto__":{"role":"SUPER_ADMIN"},"constructor":{"prototype":{"polluted":true}}}'
  });
  assert.equal(response.status, 404); await response.arrayBuffer();
  assert.equal((await fetch(base + '/api/admin/dashboard')).status, 401);
  await healthy();
});

test('path normalization and repeated query parameters cannot bypass account guards', async () => {
  for (const [pathname, status] of [
    ['/api/conta?role=USER&role=SUPER_ADMIN&user_id=1&user_id=2', 401],
    ['/api/admin/../conta', 401], ['/api/admin/%2e%2e/conta', 401],
    ['/api/%63onta', 404], ['/api%2fconta', 404], ['/api/conta%00', 404],
    ['/api//conta', 404], ['/api/conta/', 404],
    ['/api/admin/dashboard?__proto__=SUPER_ADMIN&constructor=SUPER_ADMIN', 401]
  ]) {
    const response = await raw('GET ' + pathname + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(response, new RegExp('^HTTP/1\\.1 ' + status + ' '), pathname);
  }
  for (const target of ['http://evil.test/api/conta', '//evil.test/api/conta']) {
    assert.match(await raw('GET ' + target + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400 /);
  }
  await healthy();
});

test('HTTP methods and preflight headers cannot turn a public route into a privileged operation', async () => {
  for (const method of ['OPTIONS', 'PATCH', 'TRACE', 'PUT', 'DELETE']) {
    const response = await raw(method + ' /api/admin/dashboard HTTP/1.1\r\nHost: localhost\r\nOrigin: https://evil.test\r\nAccess-Control-Request-Method: GET\r\nX-HTTP-Method-Override: GET\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 404 /, method);
    assert.doesNotMatch(response, /Access-Control-Allow-Origin:/i);
  }
  const response = await fetch(base + '/api/logout?origin=' + encodeURIComponent(base), {
    method: 'POST', headers: { ...jsonHeaders, Origin: 'https://evil.test' }, body: '{}'
  });
  assert.equal(response.status, 403); await response.arrayBuffer();
  await healthy();
});
