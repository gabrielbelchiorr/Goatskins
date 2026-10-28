/* Safe offline regression for the password-recovery timing finding.
   No environment/config file, database, provider or real address is accessed. */
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto');
async function observe(existing) {
  let release, completed = false, sends = 0, reads = 0, jobs = 0;
  const provider = new Promise(resolve => { release = resolve; });
  const mocks = {
    'node:crypto': crypto,
    './registration': { limiteEnvio: async () => {} },
    './config': { APP_URL: 'http://localhost' },
    './mail': { enviar: async () => { sends++; await provider; return { simulado: true }; } },
    './recovery': { enfileirar: async () => { jobs++; } },
    './db': { db: { get: async () => { reads++; return existing ? { id: 1, nome: 'Fixture', email: 'fixture@goatskins.test' } : undefined; },
      run: async () => ({ changes: 1 }) }, sha: s => crypto.createHash('sha256').update(s).digest('hex'),
      tx: fn => fn(), audit: async () => {} },
    './http': { RE: { email: /^[^@]+@[^@]+\.[^@]+$/ }, limite() {}, Erro: class extends Error {} }
  };
  const sandbox = { module: { exports: {} }, Buffer, Date,
    setInterval: () => ({ unref() {} }), console: { log() {}, error() {} },
    require: name => { if (!(name in mocks)) throw new Error('Unexpected import'); return mocks[name]; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/auth.js'), 'utf8'), sandbox);
  const route = sandbox.module.exports.rotas.find(r => r[1].test('/api/esqueci-senha'))[2];
  const request = route({ body: { email: 'fixture@goatskins.test' }, ip: '127.0.0.1' }).then(() => { completed = true; });
  await new Promise(setImmediate);
  const observed = { contaExiste: existing, concluiuAntesDoProvedor: completed, enviosSimulados: sends, consultasUsuarios: reads, pedidosPersistidos: jobs };
  release(); await request; return observed;
}
(async () => {
  const observations = await Promise.all([observe(false), observe(true)]);
  const corrected = observations.every(o => o.concluiuAntesDoProvedor && !o.enviosSimulados && !o.consultasUsuarios && o.pedidosPersistidos === 1);
  process.stdout.write((corrected ? 'REGRESSÃO APROVADA' : 'FALHA: resposta depende do usuário ou do provedor') + ': recuperação de senha.\n');
  process.stdout.write(JSON.stringify({ somenteMocksLocais: true, observacoes: observations }, null, 2) + '\n');
  if (!corrected) process.exitCode = 1;
})().catch(error => { console.error('Falha na reprodução offline:', error.name); process.exitCode = 1; });
