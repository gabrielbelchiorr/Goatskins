/* Recovery HTTP equivalence regressions. The real server, dispatcher, auth,
   CSRF/Turnstile validation and rate-limit implementations run on loopback.
   PostgreSQL, queue persistence and external providers are controlled doubles;
   this measures application-level leakage, not production network variance. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
// These margins are chosen before collecting samples. A non-significant
// difference alone is not evidence of equivalence. The 40/120 ms regression
// controls exceed both margins without relying on Internet timing.
const MEDIAN_MARGIN_MS = 10, P95_MARGIN_MS = 20, SAMPLES_PER_GROUP = 24;

async function fixture({ providerMs = 0, providerFails = false, dbMs = 1 } = {}) {
  let clock = 1800000000000, sequence = 0, server, queueFails = false;
  const limits = new Map(), members = new Set(), jobs = [], calls = [];
  const counters = { users: 0, provider: 0, captcha: 0, enqueued: 0 };
  const cfg = {
    TESTE: false, PRODUCAO: true, TRUST_PROXY: true, TRUST_PROXY_HOPS: 1,
    APP_URL: 'https://fixture.goatskins.test', raiz: root,
    TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret',
    TURNSTILE_HOSTNAMES: '', EMAIL_CODE_SECRET: 'fixture-only-no-delivery',
    ORIGIN_VERIFY_SECRET: ''
  };
  class Clock extends Date { static now() { return clock; } }
  const latency = async () => { if (dbMs) await sleep(dbMs); };
  const db = {
    async get(sql, args = []) {
      calls.push({ sql, args: [...args] }); await latency();
      if (/INSERT INTO auth_rate_limits/.test(sql)) {
        // Mirrors the UPSERT's condition/update using the same supplied SQL
        // parameters. The production consumirLimite function is not replaced.
        const [key, now, next, expires, , , , , , , , max] = args;
        let record = limits.get(key);
        if (record && record.expira > now && (record.n >= max || record.proximo > now)) return undefined;
        record = !record || record.expira <= now
          ? { inicio: now, n: 1, proximo: next, expira: expires }
          : { ...record, n: record.n + 1, proximo: next };
        limits.set(key, record); return { n: record.n };
      }
      if (/FROM users/i.test(sql)) {
        counters.users++;
        return members.has(args[0]) ? { id: 17, nome: 'Fixture', email: args[0] } : undefined;
      }
      throw new Error('Unexpected recovery SQL in controlled fixture');
    },
    async run(sql, args = []) {
      calls.push({ sql, args: [...args] }); await latency();
      // The historical route writes/deletes its token synchronously; retaining
      // these doubles makes the old provider-dependent implementation fail the
      // regression for its real timing/lookup behavior, rather than a mock error.
      if (/tokens_email/.test(sql)) return { changes: 1 };
      throw new Error('Unexpected recovery write in controlled fixture');
    }
  };
  const store = {
    db, sha, agora: () => new Clock(clock).toISOString(),
    async tx(fn) {
      const snapshot = new Map([...limits].map(([key, value]) => [key, { ...value }]));
      const originalLength = jobs.length;
      try { return await fn(); }
      catch (error) { limits.clear(); for (const entry of snapshot) limits.set(...entry); jobs.length = originalLength; throw error; }
    },
    audit: latency, notificar: latency,
    iniciar: () => new Promise(() => {}), fechar: async () => {}, ping: async () => {}
  };
  const mail = { async enviar() {
    counters.provider++; if (providerMs) await sleep(providerMs);
    return providerFails ? false : { simulado: true };
  } };
  const recovery = { async enfileirar(email, ip) {
    await latency();
    if (queueFails) throw new Error('Controlled persistence unavailable');
    counters.enqueued++; jobs.push({ email, ip });
  } };
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const module = { exports: {} }; cache.set(relative, module.exports);
    const sandbox = {
      module, exports: module.exports, Buffer, Date: Clock, URL, AbortSignal,
      setInterval: () => ({ unref() {} }), setTimeout, clearTimeout,
      process: { argv: ['node', 'server.js'], on() {}, exit() { throw new Error('Unexpected fixture exit'); } },
      console: { log() {}, error() {} },
      fetch: async url => {
        assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify', 'External network is forbidden');
        counters.captcha++; await latency();
        return { ok: true, json: async () => ({ success: true, hostname: 'fixture.goatskins.test', action: 'recuperacao' }) };
      },
      require(name) {
        if (name === 'node:http' && relative === 'server.js') return { ...http, createServer(fn) { server = http.createServer(fn); return server; } };
        if (name.startsWith('node:')) return require(name);
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)) + '.js';
        if (resolved === 'src/config.js') return cfg;
        if (resolved === 'src/db.js') return store;
        if (resolved === 'src/mail.js') return mail;
        if (resolved === 'src/recovery.js') return recovery;
        if (resolved === 'src/mfa.js') return { rotas: [] };
        if (['src/phone.js', 'src/rifas.js', 'src/pedidos.js', 'src/admin.js'].includes(resolved)) return { rotas: [] };
        assert.ok(['src/auth.js', 'src/registration.js', 'src/http.js', 'src/security.js'].includes(resolved), 'Unexpected import: ' + name);
        return load(resolved);
      }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, relative), 'utf8'), sandbox, { filename: relative });
    cache.set(relative, module.exports); return module.exports;
  }
  load('server.js');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  async function request(email, ip = nextIp(), extraHeaders = {}) {
    const body = JSON.stringify({ email, turnstileToken: 'fixture-turnstile' });
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/esqueci-senha', method: 'POST', agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'goatskins', Origin: cfg.APP_URL, 'X-Forwarded-For': ip, ...extraHeaders } }, res => {
        const parts = [];
        res.on('data', part => parts.push(part));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8'),
          headers: Object.fromEntries(Object.entries(res.headers).filter(([key]) => key !== 'date').sort()), ms: performance.now() - started }));
      });
      req.setTimeout(4000, () => req.destroy(new Error('Loopback recovery request timeout')));
      req.on('error', reject); req.end(body);
    });
  }
  function nextIp() { const n = ++sequence; return '198.18.' + Math.floor(n / 250) + '.' + (n % 250 + 1); }
  function address(existing) {
    // Equal length addresses and local transport avoid payload/DNS differences.
    const email = (existing ? 'member' : 'absent') + String(++sequence).padStart(5, '0') + '@goatskins.test';
    if (existing) members.add(email); return email;
  }
  return { request, address, counters, calls, jobs, limits,
    registration: load('src/registration.js'),
    addMember: email => members.add(email), tick: ms => { clock += ms; }, failQueue: () => { queueFails = true; },
    async close() { agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}

function comparable(response) { return { status: response.status, body: response.body, headers: response.headers }; }
function percentile(samples, fraction) { const ordered = [...samples].sort((a, b) => a - b); return ordered[Math.ceil(ordered.length * fraction) - 1]; }
function measurements(samples) { return { median: percentile(samples, 0.5), p95: percentile(samples, 0.95) }; }
function equivalentResponses(a, b) {
  assert.deepEqual(comparable(a), comparable(b), 'Account existence must not change status, exact body or any header other than Date');
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.equal(a.headers['set-cookie'], undefined);
  assert.equal(a.headers['retry-after'], undefined);
}

for (const scenario of [
  { providerMs: 0, providerFails: false }, { providerMs: 40, providerFails: false },
  { providerMs: 120, providerFails: false }, { providerMs: 120, providerFails: true }
]) test('recovery timing and HTTP equivalence: provider ' + scenario.providerMs + ' ms' + (scenario.providerFails ? ' unavailable' : ''), { timeout: 20000 }, async t => {
  const h = await fixture(scenario);
  try {
    const samples = { member: [], absent: [] };
    let reference;
    // Warm one persistent connection before measuring. ABBA reverses order in
    // every block to balance event-loop drift; no arbitrary production delay is
    // part of the implementation or the measured request.
    for (const existing of [true, false, false, true, true, false, false, true]) {
      const response = await h.request(h.address(existing)); assert.equal(response.status, 200);
    }
    for (let block = 0; block < SAMPLES_PER_GROUP / 2; block++) {
      for (const existing of [true, false, false, true]) {
        const response = await h.request(h.address(existing));
        assert.equal(response.status, 200); assert.equal(response.body, '{"ok":true}');
        if (reference) equivalentResponses(reference, response); else reference = response;
        samples[existing ? 'member' : 'absent'].push(response.ms);
      }
    }
    const member = measurements(samples.member), absent = measurements(samples.absent);
    const medianDifference = Math.abs(member.median - absent.median), p95Difference = Math.abs(member.p95 - absent.p95);
    t.diagnostic(JSON.stringify({ network: 'loopback, persistent connection, controlled DB 1 ms/op', samplesPerGroup: SAMPLES_PER_GROUP,
      providerMs: scenario.providerMs, providerFails: scenario.providerFails, memberMs: member, absentMs: absent,
      medianDifference, p95Difference, marginsMs: { median: MEDIAN_MARGIN_MS, p95: P95_MARGIN_MS } }));
    assert.ok(medianDifference <= MEDIAN_MARGIN_MS, 'Median difference exceeds the predefined equivalence margin');
    assert.ok(p95Difference <= P95_MARGIN_MS, 'p95 difference exceeds the predefined equivalence margin');
    assert.equal(h.counters.users, 0, 'HTTP admission must not query users or depend on account existence');
    assert.equal(h.counters.provider, 0, 'HTTP admission must not call or await the email provider');
    assert.equal(h.counters.enqueued, 8 + SAMPLES_PER_GROUP * 2, 'Both address groups must persist one job per accepted request');
    assert.equal(h.counters.captcha, 8 + SAMPLES_PER_GROUP * 2, 'Real Turnstile validation stays in the HTTP path with a controlled provider');
  } finally { await h.close(); }
});

test('recovery email cooldown and hourly cap respond identically with actual persistent limit logic', { timeout: 10000 }, async () => {
  const results = [];
  for (const existing of [true, false]) {
    const h = await fixture();
    try {
      const email = h.address(existing), responses = [];
      responses.push(await h.request(email));
      responses.push(await h.request(email)); // sixty-second cooldown
      for (let n = 1; n < 5; n++) { h.tick(60001); responses.push(await h.request(email)); }
      h.tick(60001); responses.push(await h.request(email)); // five/hour cap
      assert.deepEqual(responses.map(response => response.status), [200, 429, 200, 200, 200, 200, 429]);
      assert.equal(h.counters.enqueued, 5);
      assert.equal(h.limits.get('email:' + sha(email)).n, 5, 'Rejected transactions must not consume additional persistent sends');
      assert.equal(h.counters.users, 0); assert.equal(h.counters.provider, 0);
      results.push(responses);
    } finally { await h.close(); }
  }
  for (let n = 0; n < results[0].length; n++) equivalentResponses(results[0][n], results[1][n]);
});

test('recovery IP limits remain active and do not reveal whether target accounts exist', { timeout: 10000 }, async () => {
  const results = [];
  for (const existing of [true, false]) {
    const h = await fixture();
    try {
      const responses = [];
      for (let n = 0; n < 11; n++) responses.push(await h.request(h.address(existing), '198.18.10.1'));
      assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200, 200, 429, 429, 429, 429, 429, 429]);
      assert.equal(h.counters.enqueued, 5);
      const key = 'auth-ip:recuperacao:' + sha('198.18.10.1');
      assert.equal(h.limits.get(key).n, 10, 'The persistent pre-CAPTCHA IP limiter must also remain active');
      assert.equal(h.counters.captcha, 10, 'The eleventh request is stopped before contacting Turnstile');
      assert.equal(h.counters.users, 0); assert.equal(h.counters.provider, 0);
      results.push(responses);
    } finally { await h.close(); }
  }
  for (let n = 0; n < results[0].length; n++) equivalentResponses(results[0][n], results[1][n]);
});

for (const limit of [
  { name: 'persistent send IP', key: 'envio-ip:' + sha('198.18.11.1'), max: 20 },
  { name: 'global send', key: 'envio-global', max: 200 }
]) test('recovery ' + limit.name + ' limit has equivalent HTTP behavior at its boundary', { timeout: 10000 }, async () => {
  const results = [];
  for (const existing of [true, false]) {
    const h = await fixture();
    try {
      // Reach the boundary through the real production limiter, without making
      // hundreds of unrelated HTTP requests or disabling TESTE guards.
      for (let n = 1; n < limit.max; n++) await h.registration.consumirLimite(limit.key, limit.max, 36e5);
      const accepted = await h.request(h.address(existing), '198.18.11.1');
      const rejectedEmail = h.address(existing), rejected = await h.request(rejectedEmail, '198.18.11.1');
      assert.equal(accepted.status, 200); assert.equal(rejected.status, 429);
      assert.equal(h.counters.enqueued, 1);
      assert.equal(h.limits.get(limit.key).n, limit.max);
      assert.equal(h.limits.has('email:' + sha(rejectedEmail)), false, 'Rejected send must roll back its email allowance');
      assert.equal(h.counters.users, 0); assert.equal(h.counters.provider, 0);
      results.push([accepted, rejected]);
    } finally { await h.close(); }
  }
  for (let n = 0; n < results[0].length; n++) equivalentResponses(results[0][n], results[1][n]);
});

test('recovery queue persistence failure is equivalent and does not falsely report acceptance', { timeout: 5000 }, async () => {
  const results = [];
  for (const existing of [true, false]) {
    const h = await fixture();
    try {
      const email = h.address(existing); h.failQueue();
      const response = await h.request(email);
      assert.equal(response.status, 500); assert.equal(response.body, '{"erro":"Erro interno."}');
      assert.equal(h.jobs.length, 0);
      assert.equal(h.limits.has('email:' + sha(email)), false, 'Failed persistence rolls back send allowances');
      assert.equal(h.counters.users, 0); assert.equal(h.counters.provider, 0);
      results.push(response);
    } finally { await h.close(); }
  }
  equivalentResponses(...results);
});

test('recovery still enforces CSRF and rejects malformed addresses before admission', { timeout: 5000 }, async () => {
  const h = await fixture();
  try {
    const csrf = await h.request(h.address(true), undefined, { Origin: 'https://unrelated.test' });
    assert.equal(csrf.status, 403); assert.equal(h.counters.captcha, 0);
    const malformed = await h.request('invalid-address');
    assert.equal(malformed.status, 400); assert.match(malformed.body, /E-mail inválido/);
    assert.equal(h.jobs.length, 0); assert.equal(h.counters.users, 0); assert.equal(h.counters.provider, 0);
  } finally { await h.close(); }
});
