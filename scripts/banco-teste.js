/* Shared guard for every destructive test entry point. Never include the URL in errors. */
function bancoTeste(raw, obrigatorio = false) {
  if (!raw) {
    if (obrigatorio) throw new Error('TEST_DATABASE_URL é obrigatório para a suite completa.');
    return '';
  }
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('Use PostgreSQL local e descartável chamado goatskins_test.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/goatskins_test' || url.search || url.hash) {
    throw new Error('Use PostgreSQL local e descartável chamado goatskins_test.');
  }
  return raw;
}
module.exports = { bancoTeste };
