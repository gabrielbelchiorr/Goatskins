/* Painel admin no navegador: troca de aba sem ida extra ao /api/mfa/status, e o servidor continua
   mandando — um MFA_REQUIRED invalida o atalho e reabre a confirmação. Chrome/Edge local, fixtures, sem banco. */
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { startBrowser, executable, until } = require('./helpers/browser-cdp');

const admin = { id: 1, nome: 'Admin Fixture', role: 'SUPER_ADMIN', email_verificado: 1, celular_preenchido: true };
let expirou = false;
async function api(method, rota) {
  if (rota === '/api/estado') return { data: { eu: admin, naoLidas: 0, pix: true, viewer3d: { key: '', configurado: false },
    s: { titulo: 'GOATSKINS', sub: '', banner: '', cores: { gold: '#d4aa55', copper: '#b8651f', slate: '#102440', navy: '#0e1a33' } }, c: [] } };
  if (rota === '/api/mfa/status') return { data: expirou ? { enabled: true, verified: false, remainingRecoveryCodes: 8 } : { enabled: true, verified: true } };
  if (expirou && rota.startsWith('/api/admin/')) return { status: 403, data: { erro: 'Confirme sua identidade.', tipo: 'MFA_REQUIRED' } };
  if (rota === '/api/admin/dashboard') return { data: { operacao: { receita: 0, pix_pendentes: 0, pix_revisao: 0, reembolsos: 0, estornos: 0, entregas: 0, prontos_para_sorteio: 0 },
    usuarios: 1, verificados: 1, sorteios: [], participacoes: 0, hoje: 0, semana: 0, porSorteio: [], ultimas: [] } };
  if (rota === '/api/admin/pedidos') return { data: { receita: 0, pedidos: [] } };
  return { data: rota === '/api/pedidos/pendente' ? null : [] };
}

test('painel admin: abas sem consulta extra de MFA; MFA_REQUIRED reabre a confirmação', { skip: !executable && 'Chrome/Edge local ausente', timeout: 60000 }, async () => {
  const b = await startBrowser({ directory: path.join(__dirname, '..', 'public'), api,
    initialize: "localStorage.setItem('goatskins-cookies',JSON.stringify({version:1,preferences:false}))" });
  const status = () => b.requests.filter(r => r.pathname === '/api/mfa/status').length;
  try {
    await b.navigate('/');
    await b.cdp.evaluate('painel("painel")'); await until(() => b.cdp.evaluate('!!document.querySelector(".admin-ops")'));
    const consultas = status();
    for (const aba of ['pedidos', 'visual', 'painel']) {
      await b.cdp.evaluate('painel(' + JSON.stringify(aba) + ')');
      await until(() => b.cdp.evaluate('!document.querySelector(".admin-body[aria-busy]")'));
      assert.equal(await b.cdp.evaluate('document.querySelector(".tabs [aria-current=page]").dataset.aba'), aba);
      assert.equal(await b.cdp.evaluate('document.querySelectorAll(".tabs").length'), 1, 'o modal não é remontado');
    }
    assert.equal(status(), consultas, 'trocar de aba não consulta /api/mfa/status de novo');
    expirou = true;
    await b.cdp.evaluate('painel("usuarios")');
    await until(() => b.cdp.evaluate('!!document.querySelector(".mfa-dialog")'), 'a confirmação de MFA deveria abrir');
    assert.equal(status(), consultas + 1);
    assert.equal(await b.cdp.evaluate('mfaConfirmadoAte'), 0);
    assert.deepEqual(b.pageErrors, []); assert.deepEqual(b.externalRequests, []);
  } finally { await b.close(); }
});
