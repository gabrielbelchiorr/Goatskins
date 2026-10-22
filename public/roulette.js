/* GOATSKINS — apresentação do sorteio. O vencedor vem exclusivamente do servidor. */
(() => {
  "use strict";
  let active = null, serial = 0;
  const node = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const button = (text, cls, action) => {
    const e = node("button", cls, text); e.type = "button";
    if (action) e.addEventListener("click", action);
    return e;
  };

  function open(options) {
    if (active) { active.focus(); return active; }
    const c = options.campaign, nums = [...c.ocupados];
    if (!nums.length || nums.length > 100 || new Set(nums).size !== nums.length ||
        nums.some(n => !Number.isInteger(n) || n < 1 || n > 100)) {
      throw new Error("Não foi possível conferir os números deste sorteio. Atualize a página.");
    }
    const validate = w => {
      if (!w || !nums.includes(w.n) || typeof w.nome !== "string" || !w.nome.trim()) {
        throw new Error("Não foi possível confirmar o resultado. Consulte o Histórico antes de continuar.");
      }
      return w;
    };
    if (options.winner) validate(options.winner);
    const digits = Math.max(2, String(Math.max(...nums)).length);
    const number = n => String(n).padStart(digits, "0");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const previousFocus = document.activeElement;
    const screen = node("dialog", "roulette-screen"), inner = node("div", "roulette-inner");
    const titleId = "roulette-title-" + ++serial;
    screen.setAttribute("aria-labelledby", titleId);
    screen.setAttribute("aria-modal", "true");
    screen.dataset.phase = "ready";
    let phase = "ready", frame = 0, cards = [], current = 2, highlighted = -1;
    let metrics = { width: 900, ticket: 142, gap: 14 }, observer;

    const header = node("header", "roulette-header"), brand = node("div", "roulette-brand");
    const logo = node("img"); logo.src = options.logoSrc || "logo-marca.webp";
    logo.alt = ""; logo.width = 38; logo.height = 42;
    const brandText = node("div");
    brandText.append(node("strong", null, "GOATSKINS"), node("small", null, "SORTEIO #" + c.id));
    brand.append(logo, brandText);
    const close = button("← Voltar", "roulette-close", dismiss);
    close.setAttribute("aria-label", "Fechar a tela da roleta e voltar ao site");
    header.append(brand, close);

    const intro = node("section", "roulette-intro"), introText = node("div");
    const heading = node("h1", null, "A sorte está lançada."); heading.id = titleId;
    introText.append(node("p", "roulette-eyebrow", options.preview ? "DEMONSTRAÇÃO · SEM SORTEIO REAL" : "O MOMENTO DA SORTE"),
      heading, node("p", "roulette-subtitle", "Um número. Uma skin. Um novo ganhador."));
    const prize = node("div", "roulette-prize"), art = node("div", "roulette-prize-art");
    if (c.foto) { const image = node("img"); image.src = c.foto; image.alt = c.premio; art.append(image); }
    else { const diamond = node("span", null, "✦"); diamond.setAttribute("aria-hidden", "true"); art.append(diamond); }
    const prizeText = node("div");
    prizeText.append(node("small", "roulette-eyebrow", "EM JOGO"), node("strong", null, c.premio));
    if (c.desgaste) prizeText.append(node("span", null, c.desgaste));
    prize.append(art, prizeText); intro.append(introText, prize);

    const stage = node("section", "roulette-stage"), stageHead = node("div", "roulette-stage-head");
    const badge = node("span", "roulette-status", "PRONTA PARA GIRAR");
    stageHead.append(node("span", "roulette-eyebrow", "ROLETA GOATSKINS"), badge);
    const viewport = node("div", "roulette-viewport"), strip = node("div", "roulette-strip");
    strip.setAttribute("aria-hidden", "true");
    const marker = node("div", "roulette-marker"); marker.setAttribute("aria-hidden", "true");
    const markerValue = node("span", "roulette-marker-value"); markerValue.setAttribute("aria-hidden", "true");
    viewport.append(strip, marker);
    const markerCaption = node("p", "roulette-marker-caption", "NÚMERO NO MARCADOR "); markerCaption.append(markerValue);
    const waiting = node("div", "roulette-waiting");
    const waitingTitle = node("h2", null, "Quem leva essa skin?");
    const waitingText = node("p", null, "Todos os números participantes estão na disputa.");
    waiting.append(waitingTitle, waitingText);
    const result = node("div", "roulette-result"); result.hidden = true; result.tabIndex = -1;
    const winningNumber = node("div", "roulette-winning-number"), winnerText = node("div", "roulette-winner-text");
    const winnerName = node("h2", "roulette-winner-name"), winnerPrize = node("p");
    winnerText.append(node("p", "roulette-eyebrow", "GANHADOR(A)"), winnerName, winnerPrize);
    result.append(winningNumber, winnerText);
    const actions = node("div", "roulette-actions"), go = button("GIRAR ROLETA", "roulette-go", start);
    const history = button("Ver no Histórico", "roulette-go", () => { dismiss(); options.onHistory(); });
    history.hidden = true; actions.append(go, history);
    const message = node("p", "roulette-message", "Confira os números participantes antes de iniciar.");
    message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
    const error = node("p", "roulette-error"); error.hidden = true; error.setAttribute("role", "alert");
    const confetti = node("div", "roulette-confetti"); confetti.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 20; i++) {
      const piece = node("i"); piece.style.setProperty("--x", (8 + i * 37 % 84) + "%");
      piece.style.setProperty("--delay", (i % 5 * 0.07) + "s");
      piece.style.setProperty("--turn", (i * 73) + "deg"); confetti.append(piece);
    }
    stage.append(stageHead, viewport, markerCaption, waiting, result, actions, message, error, confetti);

    const participants = node("details", "roulette-participants"), summary = node("summary");
    summary.append(node("span", null, "Números participantes"), node("span", null, nums.length + (nums.length === 1 ? " número" : " números")));
    const list = node("div", "roulette-number-list"); list.setAttribute("aria-label", "Todos os números participantes");
    nums.forEach(n => { const e = node("span", "roulette-number", number(n)); e.dataset.number = String(n); list.append(e); });
    participants.append(summary, list);
    const foot = node("p", "roulette-footnote", options.preview ?
      "Prévia visual. Não conecta ao servidor nem grava um ganhador." :
      "O resultado fica disponível no Histórico.");
    inner.append(header, intro, stage, participants, foot); screen.append(inner);

    function setPhase(value) { phase = value; screen.dataset.phase = value; }
    function busy() { return phase === "requesting" || phase === "spinning"; }
    function dismiss() { if (!busy()) screen.close(); }
    function fill(count) {
      strip.replaceChildren(); cards = []; highlighted = -1;
      for (let i = 0; i < count; i++) {
        const card = node("div", "roulette-ticket");
        card.append(node("span", "roulette-ticket-mark", "✦"), node("small", null, "NÚMERO"), node("strong", null, number(nums[i % nums.length])), node("span", "roulette-ticket-brand", "GOATSKINS"));
        strip.append(card); cards.push(card);
      }
    }
    function position(index) {
      current = index;
      const offset = metrics.width / 2 - metrics.ticket / 2 - index * (metrics.ticket + metrics.gap);
      strip.style.transform = "translate3d(" + offset + "px,0,0)";
      const selected = Math.max(0, Math.min(cards.length - 1, Math.round(index)));
      if (selected !== highlighted) {
        cards[highlighted]?.classList.remove("is-marked"); cards[selected]?.classList.add("is-marked");
        highlighted = selected; markerValue.textContent = number(nums[selected % nums.length]);
      }
    }
    function measure() {
      const width = viewport.getBoundingClientRect().width, ticket = cards[0]?.getBoundingClientRect().width;
      metrics.width = width || metrics.width; metrics.ticket = ticket || metrics.ticket;
      metrics.gap = parseFloat(getComputedStyle(strip).gap) || 14;
      position(current);
    }
    function reveal(w, fresh) {
      cancelAnimationFrame(frame); setPhase("complete"); close.disabled = false;
      badge.textContent = "SORTEIO CONCLUÍDO"; heading.textContent = "Temos um ganhador!";
      waiting.hidden = go.hidden = true; result.hidden = false;
      winningNumber.replaceChildren(node("small", null, "NÚMERO"), node("strong", null, number(w.n)));
      winnerName.textContent = w.nome; winnerPrize.textContent = "Levou " + c.premio;
      message.textContent = options.preview ? "Resultado ilustrativo desta prévia." : "Parabéns! O resultado deste sorteio está registrado.";
      history.hidden = typeof options.onHistory !== "function";
      list.querySelectorAll(".roulette-number").forEach(e => {
        const won = Number(e.dataset.number) === w.n;
        e.classList.toggle("is-winner", won);
        if (won) e.setAttribute("aria-label", "Número vencedor: " + w.n);
      });
      if (fresh && !reduced.matches) screen.classList.add("is-celebrating");
      if (fresh) {
        result.focus({ preventScroll: true });
        result.scrollIntoView({ block: "nearest", behavior: reduced.matches ? "auto" : "smooth" });
        Promise.resolve().then(() => options.onComplete?.(w)).catch(() => {
          message.textContent = "Resultado confirmado. Atualize a página para atualizar a lista de sorteios.";
        });
      }
    }
    function animate(w) {
      const winningIndex = nums.indexOf(w.n);
      const target = 160 + ((winningIndex - 160 % nums.length + nums.length) % nums.length);
      fill(target + 9); current = 2; measure();
      setPhase("spinning"); badge.textContent = "GIRANDO";
      waitingTitle.textContent = "Acompanhe o marcador."; waitingText.textContent = "A roleta está desacelerando até o número vencedor.";
      message.textContent = "Aguarde a roleta parar para ver o ganhador.";
      go.textContent = "GIRANDO...";
      if (reduced.matches || nums.length === 1) { position(target); reveal(w, true); return; }
      const started = performance.now(), duration = 6600;
      function tick(now) {
        if (!screen.isConnected) return;
        const progress = reduced.matches ? 1 : Math.min(1, (now - started) / duration);
        position(2 + (target - 2) * (1 - Math.pow(1 - progress, 5)));
        if (progress < 1) frame = requestAnimationFrame(tick);
        else { position(target); reveal(w, true); }
      }
      frame = requestAnimationFrame(tick);
    }
    async function start() {
      if (busy() || phase === "complete") return;
      const recovering = phase === "uncertain";
      setPhase("requesting"); close.disabled = go.disabled = true; error.hidden = true;
      stage.setAttribute("aria-busy", "true"); badge.textContent = recovering ? "CONFERINDO" : "PREPARANDO";
      message.textContent = recovering ? "Consultando o resultado registrado..." : "Preparando o sorteio. Se solicitado, confirme sua identidade.";
      try {
        if (recovering) {
          const w = await options.recover();
          if (w) {
            validate(w); fill(Math.max(12, nums.length)); measure(); position(nums.indexOf(w.n)); reveal(w, true);
          } else {
            setPhase("ready"); close.disabled = go.disabled = false;
            badge.textContent = "PRONTA PARA GIRAR"; go.textContent = "GIRAR ROLETA";
            message.textContent = "Ainda não há resultado registrado. Você pode iniciar o sorteio.";
          }
        } else {
          const w = validate(await options.draw()); animate(w);
        }
      } catch (e) {
        // Uma falha de rede pode acontecer depois de gravar o vencedor. Nunca repete o POST automaticamente.
        setPhase("uncertain"); close.disabled = false; badge.textContent = "AGUARDANDO CONFERÊNCIA";
        error.textContent = e.message || "Não foi possível confirmar o sorteio."; error.hidden = false;
        go.textContent = "Consultar resultado"; go.disabled = typeof options.recover !== "function";
        message.textContent = "Confira o resultado registrado antes de tentar girar novamente.";
      } finally { stage.removeAttribute("aria-busy"); }
    }
    screen.addEventListener("cancel", e => { e.preventDefault(); dismiss(); });
    screen.addEventListener("close", () => {
      cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("resize", measure);
      screen.remove(); document.body.classList.remove("roulette-open"); active = null;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }, { once: true });
    fill(Math.max(12, nums.length)); document.body.append(screen);
    document.body.classList.add("roulette-open");
    try { screen.showModal(); }
    catch (e) { screen.remove(); document.body.classList.remove("roulette-open"); throw new Error("Atualize seu navegador para abrir a tela da roleta."); }
    measure();
    if (typeof ResizeObserver === "function") { observer = new ResizeObserver(measure); observer.observe(viewport); }
    else window.addEventListener("resize", measure);
    active = Object.freeze({ focus: () => screen.focus(), close: dismiss });
    if (options.winner) { position(nums.indexOf(options.winner.n)); reveal(options.winner, false); close.focus(); }
    else go.focus();
    return active;
  }
  window.GoatskinsRoulette = Object.freeze({ open });
})();
