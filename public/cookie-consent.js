/* Escolha local: apenas a preferência do menu é opcional. Sem rastreadores. */
(() => {
  'use strict';
  const key = 'goatskins-cookies', version = 1;
  let choice = null, banner, previousFocus;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && saved.version === version && typeof saved.preferences === 'boolean') choice = saved;
  } catch (_) { /* Armazenamento indisponível: a escolha vale nesta página. */ }
  const allowsPreferences = () => choice?.preferences === true;
  function measure() {
    document.documentElement.style.setProperty('--cookie-banner-height', banner.hidden ? '0px' : Math.ceil(banner.getBoundingClientRect().height) + 'px');
  }
  function show() {
    previousFocus = document.activeElement;
    banner.hidden = false; measure();
    banner.querySelector('button').focus({ preventScroll: true });
  }
  function save(preferences) {
    choice = { version, preferences };
    try {
      localStorage.setItem(key, JSON.stringify(choice));
      if (!preferences) localStorage.removeItem('menu');
    } catch (_) { /* A navegação continua sem acesso ao armazenamento. */ }
    banner.hidden = true; measure();
    const target = previousFocus?.isConnected ? previousFocus : document.querySelector('#menuBtn, [data-cookie-settings]');
    if (banner.contains(document.activeElement)) target?.focus({ preventScroll: true });
  }
  window.GoatskinsCookies = Object.freeze({ allowsPreferences, show });
  banner = document.createElement('section');
  banner.className = 'cookie-banner'; banner.setAttribute('aria-label', 'Preferências de cookies');
  const copy = document.createElement('div'), title = document.createElement('h2'), text = document.createElement('p'), link = document.createElement('a');
  title.textContent = 'Sua privacidade na GOATSKINS';
  text.textContent = 'Cookies essenciais mantêm seu login e a segurança do site. Se aceitar, também lembraremos sua preferência do menu. Não usamos cookies de publicidade. ';
  link.href = '/cookies.html'; link.textContent = 'Saiba mais'; text.append(link); copy.append(title, text);
  const actions = document.createElement('div'); actions.className = 'cookie-actions';
  for (const [label, optional] of [['Aceitar cookies', true], ['Somente essenciais', false]]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn alt'; button.textContent = label;
    button.addEventListener('click', () => save(optional)); actions.append(button);
  }
  banner.append(copy, actions); banner.hidden = !!choice; document.body.append(banner);
  document.querySelectorAll('[data-cookie-settings]').forEach(button => button.addEventListener('click', show));
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(banner);
  window.addEventListener('resize', measure); measure();
})();
