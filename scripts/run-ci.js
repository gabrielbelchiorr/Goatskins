/* CI nunca aceita sucesso com testes de API ignorados ou um banco de produção.
   Nome run-ci: evita que node --test descubra e execute este runner como teste. */
const { spawnSync } = require('node:child_process');
require('./banco-teste').bancoTeste(process.env.TEST_DATABASE_URL, true);
const result = spawnSync(process.execPath, ['--no-warnings', '--test', '--test-concurrency=1'], {
  stdio: 'inherit', env: process.env, cwd: require('node:path').join(__dirname, '..')
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
