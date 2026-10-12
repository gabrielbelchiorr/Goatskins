/* CI nunca aceita sucesso com testes de API ignorados ou um banco de produção.
   Nome run-ci: evita que node --test descubra e execute este runner como teste. */
const { spawnSync } = require('node:child_process');
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw new Error('TEST_DATABASE_URL é obrigatório para a suite completa.');
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    decodeURIComponent(url.pathname) !== '/goatskins_test' || url.search || url.hash) {
  throw new Error('CI exige um PostgreSQL local e descartável chamado goatskins_test.');
}
const result = spawnSync(process.execPath, ['--no-warnings', '--test', '--test-concurrency=1'], {
  stdio: 'inherit', env: process.env, cwd: require('node:path').join(__dirname, '..')
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
