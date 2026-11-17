/* Reproducible local audit. Never accepts a remote/non-test database. Dependency
   advisories are queried separately; application tests have loopback-only egress. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const database = require('./banco-teste').bancoTeste(process.env.TEST_DATABASE_URL, true);
const root = path.join(__dirname, '..');
const argument = process.argv.indexOf('--output');
const output = path.resolve(root, argument < 0 ? 'validation/security-audit' : process.argv[argument + 1]);
const withinValidation = path.relative(path.join(root, 'validation'), output);
if (withinValidation.startsWith('..') || path.isAbsolute(withinValidation)) throw Error('Audit output must be inside validation/.');
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'goatskins-security-audit-'));
const isolation = path.join(__dirname, 'security-isolation.js');
const clean = require('../tests/helpers/ambiente-teste');
const env = { ...process.env, ...clean, TEST_DATABASE_URL: database, DATABASE_URL: database,
  SECURITY_AUDIT_OUTPUT: output,
  DATABASE_CA: '', PG_POOL_MAX: '10', DATA_DIR: data, TRUST_PROXY: '0', TRUST_PROXY_HOPS: '1',
  MP_API_BASE: 'http://127.0.0.1:9', RESERVA_SEGUNDOS: '', PIX_MINUTOS: '30',
  SQLITE_PATH: path.join(data, 'unused.db'), DATABASE_PATH: '',
  NODE_OPTIONS: '--require ' + JSON.stringify(isolation.replaceAll('\\', '/')) };
const started = new Date().toISOString();
function run(label, binary, args, childEnv = env) {
  const filename = path.join(output, label);
  const file = fs.openSync(filename, 'w');
  console.log('Running ' + label + ' (evidence: ' + path.relative(root, filename) + ')');
  let result;
  try { result = spawnSync(binary, args, { cwd: root, env: childEnv, stdio: ['ignore', file, file] }); }
  finally { fs.closeSync(file); }
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, signal: result.signal || null };
}
const steps = {};
steps.routes = run('routes.jsonl', process.execPath, ['scripts/security-route-inventory.js']);
steps.secrets = run('secrets.jsonl', process.execPath, ['-e', `
  const {execFileSync}=require('node:child_process');
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z']).toString('utf8').split('\\0').filter(Boolean);
  const result=require('./scripts/verificar-segredos').scanTracked(process.cwd(),files);
  for(const finding of result.findings)console.error(JSON.stringify(finding));
  console.log(JSON.stringify({check:'tracked-and-untracked-secret-heuristics',scanned:result.scanned,
    skippedBinary:result.binary,skippedOversized:result.oversized,missingWorkingFiles:result.deleted,findings:result.findings.length,
    limitations:'Excludes ignored files, runtime .env, Git history, binary/UTF-16 and files over 2 MiB; limited secret patterns.'}));
  process.exitCode=result.findings.length?1:0;
`]);
// Registry advisories are the only external query; no application credentials
// are supplied, and the application is never started in this subprocess.
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
steps.dependencies = run('dependencies.json', process.execPath, [npmCli, 'audit', '--json', '--omit=dev'], {
  ...env, NODE_OPTIONS: '', MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '', EMAIL_API_KEY: ''
});
steps.tests = run('tests.tap', process.execPath, ['--no-warnings', '--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/**/*.test.js']);
const tap = fs.readFileSync(path.join(output, 'tests.tap'), 'utf8');
const counts = {};
for (const match of tap.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (.+)$/gm)) counts[match[1]] = Number(match[2]);
const hashes = {};
function hashFile(filename) { hashes[path.relative(root, filename).replaceAll('\\', '/')] = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (entry.isFile()) hashFile(filename);
  }
}
for (const dir of ['src', 'public', 'scripts', 'tests']) walk(path.join(root, dir));
for (const file of ['server.js', 'package.json', 'package-lock.json']) hashFile(path.join(root, file));
fs.writeFileSync(path.join(output, 'source-sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
const summary = { started, ended: new Date().toISOString(), node: process.version,
  database: { host: new URL(database).hostname, port: new URL(database).port || '5432', name: 'goatskins_test' },
  isolation: 'Application-level Node preload: loopback TCP/fetch, no UDP, runtime .env reader blocked; no OS sandbox.',
  steps, counts, limitations: ['Skipped tests must be reviewed individually.', 'No production or real financial integration validation.',
    'Secret scan covers tracked and untracked non-ignored text, not history or all secret formats.'],
  temporaryData: data };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ steps, counts, output: path.relative(root, output) }, null, 2));
process.exitCode = Object.values(steps).some(step => step.exitCode !== 0) || !counts.tests || counts.fail || counts.cancelled ? 1 : 0;
