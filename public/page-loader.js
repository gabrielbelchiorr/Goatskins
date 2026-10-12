/* Pequeno e executado no head: o primeiro desenho da página já mostra o loading.
   Sem JavaScript, a classe não é aplicada e a página continua visível. */
(() => {
  const root = document.documentElement;
  const started = performance.now();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let finished = false, failed = false;
  root.classList.add('page-loading');
  root.setAttribute('aria-busy', 'true');

  function showError() {
    const overlay = document.getElementById('pageLoader');
    if (!overlay) return;
    overlay.classList.add('is-error');
    document.getElementById('loaderMessage').textContent = 'Não conseguimos carregar agora. Tente novamente em instantes.';
    document.getElementById('loaderRetry').hidden = false;
    root.setAttribute('aria-busy', 'false');
  }
  function fail() {
    if (finished) return;
    failed = true;
    clearTimeout(watchdog);
    showError();
  }
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    // Só uma passagem breve quando a resposta é instantânea; não simula porcentagens.
    setTimeout(() => {
      const overlay = document.getElementById('pageLoader');
      if (overlay) overlay.classList.add('is-leaving');
      root.classList.remove('page-loading');
      root.removeAttribute('aria-busy');
      if (overlay) setTimeout(() => overlay.remove(), reducedMotion ? 0 : 180);
    }, reducedMotion ? 0 : Math.max(0, 280 - (performance.now() - started)));
  }
  const watchdog = setTimeout(fail, 20000);
  window.GoatskinsLoading = Object.freeze({ finish, fail });
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('loaderRetry')?.addEventListener('click', () => location.reload());
    if (failed) showError();
  }, { once: true });
})();
