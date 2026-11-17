/* Offline route inventory: no .env, app startup, database query or network request.
   Regenerate with: node scripts/security-route-inventory.js */
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const originalRead = fs.readFileSync;
fs.readFileSync = function (file) {
  if ((typeof file === 'string' || file instanceof URL) && path.basename(String(file)) === '.env') {
    const error = new Error('Runtime environment files are excluded from route inventory');
    error.code = 'ENOENT'; throw error;
  }
  return originalRead.apply(this, arguments);
};
require('../tests/helpers/ambiente-teste');
Object.assign(process.env, { TESTE: '1', DATABASE_CA: '', PG_POOL_MAX: '1', TRUST_PROXY: '0', TRUST_PROXY_HOPS: '1',
  MP_API_BASE: 'http://127.0.0.1:1', PIX_MINUTOS: '30', RESERVA_SEGUNDOS: '', DATA_DIR: path.join(root, 'validation', 'route-inventory-unused') });
global.fetch = async () => { throw new Error('Network is forbidden during route inventory'); };
const { Pool } = require('pg');
Pool.prototype.query = Pool.prototype.connect = async () => { throw new Error('Database access is forbidden during route inventory'); };
const modules = new Map();
function localRequire(name) {
  if (!/^\.\/src\/[a-z]+$/.test(name)) throw new Error('Unexpected dispatcher dependency');
  const exports = require(path.join(root, name)); modules.set(name.slice(2) + '.js', exports); return exports;
}
function routePath(rx) {
  const value = rx.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/')
    .replace(/\(\\d\+\)/g, ':id').replace(/\(\[a-f0-9\]\{32\}\)/g, ':pedido');
  if (/[()^$]/.test(value)) throw new Error('Unhandled route pattern: ' + rx.source);
  return value;
}
function effectiveGuard(route, guard) {
  if (guard === 'super') return 'SUPER_ADMIN + MFA elevado';
  if (guard === 'admin' || route.startsWith('/api/admin/')) return 'ADMIN/SUPER_ADMIN + MFA elevado';
  if (guard === 'webhook') return 'HMAC do provedor; sem sessão/CSRF';
  if (route.startsWith('/api/mfa/')) return 'Sessão ADMIN/SUPER_ADMIN; senha/código conforme operação';
  if (guard === 'user') return 'Sessão ativa, e-mail verificado';
  return 'Pública; pode usar sessão opcional';
}
function extraControl(route, method) {
  if (route === '/api/registro') return 'Turnstile; validação e limites de cadastro';
  if (route === '/api/login') return 'Senha; limites persistentes; Turnstile após limiar';
  if (route === '/api/esqueci-senha') return 'Turnstile; fila durável; limites de envio';
  if (/\/(confirmar-cadastro|reenviar-verificacao)$/.test(route)) return 'Token da solicitação; código/limites conforme operação';
  if (route === '/api/redefinir-senha') return 'Token secreto, válido e de uso único';
  if (route === '/api/cancelar-cadastro') return 'Token secreto da solicitação';
  if (route === '/api/conta/senha') return 'Senha atual; hash revalidado; revoga sessões e abre sessão nova';
  if (route === '/api/conta/excluir') return 'Senha atual; somente USER; bloqueia Pix/reembolso pendente; anonimiza';
  if (route === '/api/conta' && method === 'PUT') return 'Campos explícitos; revalida sessão sob trava; auditoria atômica';
  if (/^\/api\/campanhas\/:id\/(numeros|pedidos)$/.test(route)) return 'Celular válido preenchido; limites/regras na transação';
  if (/^\/api\/pedidos/.test(route)) return 'Filtro por user_id; provedor consultado ao atualizar';
  if (route === '/api/mfa/status') return 'Revalida sessão/papel; não exige elevação prévia';
  if (route === '/api/mfa/preparar') return 'Senha atual; segredo cifrado e vinculado à sessão';
  if (route === '/api/mfa/verificar') return 'Senha + TOTP/recuperação; consumo atômico; rotação de sessão';
  if (route === '/api/webhooks/mercadopago') return 'Assinatura temporal; consulta servidor a servidor; idempotência';
  if (method !== 'GET') return 'CSRF: X-Requested-With, Origin e Sec-Fetch-Site';
  return 'Controles centrais e específicos do handler';
}

(async () => {
  let store;
  try {
    const server = originalRead(path.join(root, 'server.js'), 'utf8');
    const expression = server.match(/^const ROTAS = (\[[^\r\n]+\]);$/m);
    if (!expression) throw new Error('Dispatcher declaration changed; review inventory extractor');
    const security = localRequire('./src/security'), auth = localRequire('./src/auth');
    store = require('../src/db');
    const routes = vm.runInNewContext(expression[1], { security, auth, require: localRequire });
    const sources = new Map();
    for (const [filename, mod] of modules) for (const tuple of mod.rotas || []) sources.set(tuple, filename);
    const counts = { public: 0, user: 0, admin: 0, super: 0, webhook: 0 };
    const rows = [];
    for (const tuple of routes) {
      const [method, rx, , guard] = tuple, pathname = routePath(rx), file = sources.get(tuple);
      if (!file) throw new Error('Route source missing');
      const source = originalRead(path.join(root, file), 'utf8');
      const line = source.split(/\r?\n/).findIndex(text => text.includes(rx.toString())) + 1;
      counts[guard || 'public']++;
      rows.push(`| ${method} | \`${pathname}\` | \`${guard || 'sem guarda declarada'}\` | ${effectiveGuard(pathname, guard)} | ${extraControl(pathname, method)} | [${file}:${line}](${file}#L${line}) |`);
    }
    const staticList = server.match(/const PUBLICOS = new Set\(\[([\s\S]*?)\]\);/);
    if (!staticList) throw new Error('Static allowlist changed');
    const publicFiles = [...staticList[1].matchAll(/'([^']+)'/g)].map(m => '/' + m[1]);
    const content = `# Inventário de rotas GOATSKINS

Gerado do código em ${new Date().toISOString().slice(0, 10)} com \`node scripts/security-route-inventory.js\`. O script extrai a composição real de \`ROTAS\` de \`server.js\` e os arrays exportados dos módulos; não inicia o aplicativo, não abre \`.env\`, não executa SQL e bloqueia acesso à rede. Ao terminar, fecha o pool sem iniciar conexão.

Total: **${routes.length} rotas de API**. Guardas declaradas: ${counts.public} públicas, ${counts.user} \`user\`, ${counts.admin} \`admin\`, ${counts.super} \`super\`, ${counts.webhook} \`webhook\`. As rotas de MFA declaram \`user\` e também exigem papel administrativo no próprio módulo.

Esta tabela documenta controles presentes no código. A aprovação de segurança depende dos testes de integração e do estado do banco, descritos em \`SECURITY_AUDIT_REPORT.md\`.

No dispatcher, todo caminho \`/api/admin/\` exige sessão, papel ADMIN/SUPER_ADMIN e MFA elevado; \`super\` exige SUPER_ADMIN. Autorizações administrativas são revalidadas sob a trava de escrita e antes do commit. Rotas \`user\` revalidam a sessão na entrada da transação sob a mesma trava; operações como troca de senha e MFA podem revogar/rotacionar a própria sessão. Sessões precisam estar ativas, não expiradas e vinculadas a conta ativa com e-mail verificado. POST/PUT/DELETE usam proteção CSRF por cabeçalho personalizado e origem; o webhook autentica pelo HMAC. A API aplica limite por IP e orçamento de corpo de 100 KB, elevado a 5 MB apenas no prefixo administrativo.

| Método | Caminho | Guarda declarada | Acesso efetivo | Controle específico relevante | Fonte |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Superfícies fora da API

| Método | Caminho | Comportamento |
| --- | --- | --- |
| GET, HEAD | \`/healthz\` | Público; consulta de disponibilidade do PostgreSQL; 200 ou 503, sem detalhes do banco. Passa antes da proteção opcional de segredo de origem. |
| GET, HEAD | \`/\` | Serve \`public/index.html\`. |
| GET, HEAD | Lista abaixo | Somente arquivos estáticos explicitamente permitidos, contidos em \`public\`, sem arquivos ocultos nem symlink final. |
| Outros métodos | Arquivos estáticos | 405. |
| Métodos/caminhos não registrados | \`/api/*\` | 404; não existe override de método. |

Arquivos permitidos: ${publicFiles.map(p => '\`' + p + '\`').join(', ')}.

Comandos de terminal como \`criar-admin\`, migração e backup não são rotas HTTP. Simuladores e verificadores em \`scripts/\` não são iniciados pelo servidor da aplicação. A configuração de proxy/TLS/WAF da hospedagem exige verificação independente do código.
`;
    fs.writeFileSync(path.join(root, 'SECURITY_API_ROUTES.md'), content);
    process.stdout.write(JSON.stringify({ routes: routes.length, guards: counts, staticFiles: publicFiles.length, databaseQueries: 0, externalRequests: 0 }) + '\n');
  } finally { if (store) await store.fechar(); }
})().catch(() => { console.error('Route inventory failed; no environment values printed.'); process.exitCode = 1; });
