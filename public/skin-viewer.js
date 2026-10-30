/* Iframe oficial CS2Inspect criado sob demanda e descartado ao fechar. */
(function () {
  'use strict';
  let active = null, embedKey = '';
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const messages = Object.freeze({
    no_key:'O visualizador ainda não foi ativado. O administrador precisa configurar a chave pública de embed.',
    bad_key:'A chave de embed não foi aceita pelo CS2Inspect. O administrador deve conferir a configuração.',
    revoked:'A chave de embed foi desativada no CS2Inspect. O administrador precisa reativá-la ou substituí-la.',
    origin_not_allowed:'Este domínio não está autorizado na chave do CS2Inspect. O administrador deve adicioná-lo no painel do provedor.',
    no_origin:'O CS2Inspect não identificou a página que abriu o visualizador. Recarregue a página e tente novamente.',
    unknown_item:'A skin ou o identificador informado não foi encontrado no catálogo do CS2Inspect. Confira a configuração 3D.',
    no_model:'O modelo desta skin não pôde ser carregado. Tente novamente mais tarde.',
    rate_limited:'O CS2Inspect limitou temporariamente os carregamentos. Aguarde um pouco antes de tentar novamente.'
  });
  function show(options) {
    if (!window.GoatCS2Inspect) throw new Error('O visualizador está indisponível. Atualize a página e tente novamente.');
    const config = GoatCS2Inspect.normalize(options.config);
    const src = GoatCS2Inspect.frameUrl(config,options.key === undefined ? embedKey : options.key);
    if (active) active.close();
    const opener = document.activeElement;
    const dialog = element('dialog','skin-viewer');
    if (typeof dialog.showModal !== 'function') throw new Error('Seu navegador não suporta esta janela. Atualize o navegador para visualizar a skin em 3D.');
    dialog.setAttribute('aria-labelledby','skin-viewer-title'); dialog.setAttribute('aria-describedby','skin-viewer-description');
    const head = element('div','skin-viewer-head'), names = element('div');
    names.append(element('p','skin-viewer-eyebrow','GOATSKINS · VISUALIZAÇÃO 3D'));
    const title = element('h2','',options.title || 'Visualizar skin em 3D'); title.id='skin-viewer-title'; names.append(title);
    const closeButton = element('button','skin-viewer-close','×');
    closeButton.type='button'; closeButton.setAttribute('aria-label','Fechar visualização 3D'); head.append(names,closeButton);
    const description = element('p','skin-viewer-description',config.manual ? 'Representação configurada manualmente. Float, padrão, adesivos e outros detalhes podem diferir do prêmio. Consulte as informações do sorteio.' : 'Modelo configurado com os atributos informados pelo administrador. Consulte as informações do sorteio para confirmar os atributos do prêmio.');
    description.id='skin-viewer-description';
    const viewport = element('div','skin-viewer-viewport'), loading = element('div','skin-viewer-loading');
    const spinner = element('span','skin-viewer-spinner'); spinner.setAttribute('aria-hidden','true');
    loading.append(spinner,element('span','','Preparando a skin…')); loading.setAttribute('role','status');
    const status = element('p','skin-viewer-status','O CS2Inspect está preparando o modelo e as texturas.');
    status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const footer = element('div','skin-viewer-footer');
    const instructions = element('p','','Arraste para rotacionar e use a roda do mouse ou os gestos para aproximar. Os controles do visualizador permitem alternar a câmera e inspecionar em primeira pessoa, quando compatível.');
    const retry = element('button','btn alt skin-viewer-retry','Recarregar visualizador'); retry.type='button';
    const help = element('p','skin-viewer-help','Se o modelo não aparecer, recarregue ou tente outro navegador com WebGL. Uma falha do serviço não altera o sorteio.');
    footer.append(instructions,retry); dialog.append(head,description,viewport,status,footer,help); document.body.append(dialog);
    let frame = null, timeout = null, alive = true, ready = false, failed = false;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow='hidden';
    const releaseFrame = () => {
      clearTimeout(timeout);
      if (frame) {frame.onload=frame.onerror=null;frame.remove();frame=null;}
      viewport.replaceChildren();
    };
    const close = () => {
      if (!alive) return;
      alive=false; releaseFrame(); window.removeEventListener('message',onMessage); document.removeEventListener('keydown',onKey,true);
      dialog.close(); dialog.remove(); document.body.style.overflow=previousOverflow; active=null;
      if (opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus({preventScroll:true});
    };
    const fail = message => {
      if (!alive) return;
      clearTimeout(timeout); failed=true; loading.hidden=true; status.classList.add('is-error'); status.textContent=message; retry.textContent='Tentar novamente';
      if (frame) frame.removeAttribute('aria-busy');
    };
    const start = () => {
      releaseFrame(); ready=false; failed=false;
      status.classList.remove('is-error'); status.textContent='O CS2Inspect está preparando o modelo e as texturas.'; retry.textContent='Recarregar visualizador'; loading.hidden=false;
      frame=element('iframe','skin-viewer-frame'); frame.title='CS2Inspect: visualizador 3D da skin CS2';
      frame.referrerPolicy='strict-origin-when-cross-origin'; frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-pointer-lock');
      frame.setAttribute('allow','fullscreen'); frame.setAttribute('allowfullscreen',''); frame.setAttribute('aria-busy','true');
      frame.onload = () => {
        if (!alive || ready || failed) return;
        // load só confirma o documento. O evento oficial ready confirma a preparação.
        status.textContent='Janela carregada. O CS2Inspect está preparando a skin…';
      };
      frame.onerror = () => fail('Não foi possível abrir o CS2Inspect. Verifique sua conexão e tente novamente.');
      viewport.append(frame,loading); frame.src=src;
      timeout=setTimeout(()=>fail('O CS2Inspect está demorando para responder. Você pode aguardar ou tentar novamente.'),25000);
    };
    const onMessage = event => {
      if (!alive || !frame || event.origin!==GoatCS2Inspect.ORIGIN || event.source!==frame.contentWindow || !event.data || typeof event.data!=='object' || event.data.source!=='cs2inspect-embed') return;
      if (event.data.type==='ready') {
        clearTimeout(timeout); ready=true; failed=false; loading.hidden=true; frame.removeAttribute('aria-busy');
        status.classList.remove('is-error'); status.textContent='Skin preparada. Use os controles do visualizador para explorar o modelo.'; retry.textContent='Recarregar visualizador';
      } else if (event.data.type==='error') {
        fail(Object.hasOwn(messages,event.data.reason) ? messages[event.data.reason] : 'O CS2Inspect não conseguiu preparar esta skin. Confira a configuração ou tente novamente mais tarde.');
      }
    };
    const onKey = event => {
      if (event.key==='Escape') {event.preventDefault();event.stopImmediatePropagation();close();}
      if (event.key!=='Tab') return;
      const controls=[...dialog.querySelectorAll('button:not(:disabled),iframe,a[href],[tabindex="0"]')].filter(node=>node.getClientRects().length);
      const first=controls[0],last=controls[controls.length-1];
      if (event.shiftKey && document.activeElement===first) {event.preventDefault();last.focus();}
      else if (!event.shiftKey && document.activeElement===last) {event.preventDefault();first.focus();}
    };
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('click',event=>{
      if (event.target!==dialog) return;
      const rect=dialog.getBoundingClientRect();
      if (event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) close();
    });
    closeButton.addEventListener('click',close); retry.addEventListener('click',start); document.addEventListener('keydown',onKey,true); window.addEventListener('message',onMessage);
    active={close}; dialog.showModal(); closeButton.focus({preventScroll:true}); start(); return {close};
  }
  window.GoatSkinViewer=Object.freeze({
    configure: options=>{embedKey=typeof options?.key==='string'?options.key:'';},
    open: options=>show(options || {}),
    close:()=>active?.close()
  });
})();
