/* Pedidos e pagamentos (Pix via Mercado Pago Orders API).
   Regras de ouro:
   1. O servidor calcula o preço a partir do banco. O navegador só diz QUAIS números quer.
   2. Reservar números e criar o pedido acontece numa transação só (BEGIN IMMEDIATE + chaves únicas).
   3. Um pedido só vira PAID depois que o servidor CONSULTA o Mercado Pago e confere status, valor e referência.
      O webhook apenas "avisa que algo mudou": o que vale é a resposta da API do Mercado Pago.
   4. Tudo é idempotente: a mesma notificação 10 vezes produz o mesmo resultado de 1 vez. */
const crypto = require("node:crypto");
const cfg = require("./config"), mp = require("./mercadopago");
const { db, agora, tx, audit, notificar, liberar } = require("./db");
const { Erro, inteiro, limite } = require("./http");

const MAX_PENDENTES = 3;                                   // pedidos Pix abertos por pessoa (evita "segurar" números sem pagar)
const centavos = v => Math.round(Number(v) * 100);
const RE_PUBLIC = /^[a-f0-9]{32}$/, RE_MP_ID = /^ORD[A-Za-z0-9]{10,60}$/;
const HOST_OK = /^https:\/\/([a-z0-9-]+\.)*(mercadopago\.com(\.br)?|mercadolibre\.com)\//i;
const B64 = /^[A-Za-z0-9+/]+=*$/;
/* BR Code do Pix termina em "6304" + CRC16-CCITT (poli 0x1021, inicial 0xFFFF) calculado sobre todo o texto anterior, inclusive o "6304". */
function crc16(txt) { let c = 0xFFFF; for (const b of Buffer.from(txt, "utf8")) { c ^= b << 8; for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, "0"); }
const brcodeOk = q => typeof q === "string" && q.length > 20 && q.startsWith("000201") && q.slice(-8, -4) === "6304" && crc16(q.slice(0, -4)) === q.slice(-4).toUpperCase();

const publico = p => ({
  id: p.public_id, campanha: p.campaign_id, premio: p.premio, numeros: JSON.parse(p.numeros), total: p.total_centavos / 100,
  status: p.status, expira_em: p.expira_em, criado_em: p.criado_em, pago_em: p.pago_em,
  pix: p.status === "PENDING" && p.qr_code ? { qr_code: p.qr_code, qr_code_base64: p.qr_code_base64, ticket_url: p.ticket_url } : null });
const SEL = "SELECT p.*, c.premio FROM pedidos p JOIN campaigns c ON c.id=p.campaign_id";

/* Interpreta a Order devolvida pelo Mercado Pago. Retorna { estado: PAGO|FALHOU|PENDENTE, novo?, motivo? } */
function interpretar(o, p) {
  const pg = o && o.transactions && Array.isArray(o.transactions.payments) ? o.transactions.payments[0] : null;
  if (!o || o.id !== p.mp_order_id || o.external_reference !== p.public_id) return { estado: "PENDENTE", motivo: "referência diferente" };
  if (o.status === "processed" && o.status_detail === "accredited" && pg && pg.status === "processed") {
    const pago = o.total_paid_amount !== undefined ? o.total_paid_amount : pg.paid_amount;
    if (pago === undefined || centavos(o.total_amount) !== p.total_centavos || centavos(pago) !== p.total_centavos)
      return { estado: "PENDENTE", motivo: "valor divergente ou ausente" };      // nunca marca como pago com valor diferente
    return { estado: "PAGO" };
  }
  const st = String(o.status || ""), ps = pg ? String(pg.status || "") : "";
  const ruim = ["canceled", "expired", "failed"];
  if (ruim.includes(st) || ruim.includes(ps)) return { estado: "FALHOU", novo: { canceled: "CANCELED", expired: "EXPIRED", failed: "FAILED" }[ruim.includes(st) ? st : ps] };
  return { estado: "PENDENTE" };                                                 // action_required, created, processing... NÃO é pago
}

/* Aplica o resultado no banco. Idempotente. Retorna o status final do pedido. */
function aplicar(pedidoId, o) {
  return tx(async () => {
    await liberar();
    const p = await db.get("SELECT * FROM pedidos WHERE id=?", [pedidoId]), r = interpretar(o, p), agoraIso = agora();
    if (p.status === "PAID" || p.status === "REFUND_NEEDED" || p.status === "REFUNDED") {
      if (p.status === "PAID" && o && ["refunded", "charged_back"].includes(o.status)) await audit(p.user_id, "PAGAMENTO_ESTORNADO_NO_MP", "pedido " + p.id + " (" + o.status + ")");
      return p.status;
    }
    if (r.motivo) await audit(p.user_id, "PAGAMENTO_IGNORADO", "pedido " + p.id + ": " + r.motivo);
    if (r.estado === "PENDENTE") { await db.run("UPDATE pedidos SET mp_status=?, atualizado_em=? WHERE id=?", [String(o && o.status || "").slice(0, 40), agoraIso, p.id]); return p.status; }
    if (r.estado === "FALHOU") {
      if (p.status === "PENDING") {
        await db.run("UPDATE pedidos SET status=?, mp_status=?, atualizado_em=? WHERE id=?", [r.novo, String(o.status || "").slice(0, 40), agoraIso, p.id]);
        await db.run("DELETE FROM reservas WHERE pedido_id=?", [p.id]);
        await notificar(p.user_id, "Pagamento não concluído", "O Pix do seu pedido não foi concluído e os números foram liberados.");
      }
      return (await db.get("SELECT status FROM pedidos WHERE id=?", [p.id])).status;
    }
    /* PAGO: confirmar os números */
    const nums = JSON.parse(p.numeros), c = await db.get("SELECT status FROM campaigns WHERE id=?", [p.campaign_id]);
    const aindaReservado = (await db.get("SELECT COUNT(*) n FROM reservas WHERE pedido_id=?", [p.id])).n === nums.length;
    if (!aindaReservado) { // a reserva venceu antes do pagamento chegar: só vende se os números continuam livres
      let ocupado = !c || c.status !== "OPEN";
      for (const n of nums) {
        if (ocupado) break;
        if (await db.get("SELECT 1 FROM tickets WHERE campaign_id=? AND n=?", [p.campaign_id, n]) || await db.get("SELECT 1 FROM reservas WHERE campaign_id=? AND n=?", [p.campaign_id, n])) ocupado = true;
      }
      if (ocupado) {
        await db.run("UPDATE pedidos SET status='REFUND_NEEDED', mp_status='processed', atualizado_em=?, pago_em=? WHERE id=?", [agoraIso, agoraIso, p.id]);
        await audit(p.user_id, "PAGAMENTO_TARDIO_REEMBOLSAR", "pedido " + p.id + " pago após a reserva vencer e os números não estão mais livres");
        await notificar(p.user_id, "Pagamento recebido após o prazo", "Os números do seu pedido já não estavam disponíveis. O valor será devolvido; fale com o suporte se precisar.");
        return "REFUND_NEEDED";
      }
    }
    try { for (const n of nums) await db.run("INSERT INTO tickets(campaign_id,user_id,n,criado_em) VALUES(?,?,?,?)", [p.campaign_id, p.user_id, n, agoraIso]); }
    catch (e) { if (e.code !== "23505") throw e; throw new Erro("Conflito ao confirmar números.", 409); } // 23505 = UNIQUE violada; desfaz a transação inteira
    await db.run("DELETE FROM reservas WHERE pedido_id=?", [p.id]);
    await db.run("UPDATE pedidos SET status='PAID', mp_status='processed', pago_em=?, atualizado_em=? WHERE id=?", [agoraIso, agoraIso, p.id]);
    await audit(p.user_id, "PAGAMENTO_CONFIRMADO", "pedido " + p.id + " números " + nums.join(","));
    await notificar(p.user_id, "Pagamento confirmado!", "Seus números estão garantidos: " + nums.join(", ") + ".");
    return "PAID";
  });
}

setInterval(() => { tx(() => liberar()).catch(e => console.error("varredura:", e.message)); }, 60e3).unref();

const rotas = [
  /* 1-8: o usuário escolhe os números; preço e disponibilidade vêm SEMPRE do banco */
  ["POST", /^\/api\/campanhas\/(\d+)\/pedidos$/, async ctx => {
    const u = ctx.user, campId = Number(ctx.params[0]); limite("pedido:" + u.id, 10, 6e5);
    if (!mp.configurado()) throw new Erro("Pagamentos indisponíveis no momento.", 503);
    if (!u.email_verificado) throw new Erro("Confirme seu e-mail para participar.", 403);
    const nums = ctx.body.numeros;
    if (!Array.isArray(nums) || !nums.length || nums.length > 100) throw new Erro("Escolha pelo menos um número.");
    const lista = [...new Set(nums.map(n => inteiro(n, 1, 100)))]; // preço, total, status e valor de qualquer outro campo do corpo são ignorados
    const publicId = crypto.randomBytes(16).toString("hex");
    const pedido = await tx(async () => {
      await liberar();
      const c = await db.get("SELECT * FROM campaigns WHERE id=?", [campId]); if (!c) throw new Erro("Sorteio não encontrado.", 404);
      if (c.status !== "OPEN") throw new Erro("Este sorteio não está aberto.");
      if (c.preco_centavos <= 0) throw new Erro("Este sorteio é gratuito: escolha os números direto no sorteio.");
      if (lista.some(n => n > c.max)) throw new Erro("Número fora do sorteio.");
      if ((await db.get("SELECT COUNT(*) n FROM pedidos WHERE user_id=? AND status='PENDING'", [u.id])).n >= MAX_PENDENTES)
        throw new Erro("Você já tem pedidos Pix aguardando pagamento. Pague ou aguarde expirarem.", 429);
      const comprados = (await db.get("SELECT COUNT(*) n FROM tickets WHERE campaign_id=? AND user_id=?", [campId, u.id])).n;
      const reservados = (await db.get("SELECT COUNT(*) n FROM reservas r JOIN pedidos p ON p.id=r.pedido_id WHERE r.campaign_id=? AND p.user_id=?", [campId, u.id])).n;
      if (comprados + reservados + lista.length > c.max_por_usuario) throw new Erro("Limite de " + c.max_por_usuario + " número(s) por pessoa neste sorteio.");
      const total = c.preco_centavos * lista.length, agoraIso = agora();
      const id = await db.insert("INSERT INTO pedidos(public_id,user_id,campaign_id,numeros,total_centavos,expira_em,criado_em,atualizado_em) VALUES(?,?,?,?,?,?,?,?)",
        [publicId, u.id, campId, JSON.stringify(lista.sort((a, b) => a - b)), total, Date.now() + cfg.RESERVA_MS, agoraIso, agoraIso]);
      for (const n of lista) {
        if (await db.get("SELECT 1 FROM tickets WHERE campaign_id=? AND n=?", [campId, n])) throw new Erro("O número " + n + " já foi vendido.");
        try { await db.run("INSERT INTO reservas(campaign_id,n,pedido_id) VALUES(?,?,?)", [campId, n, id]); }   // PRIMARY KEY (campanha, número): garantia final
        catch (e) { if (e.code === "23505") throw new Erro("O número " + n + " já foi escolhido ou está reservado por outra pessoa."); throw e; } // 23505 = chave duplicada
      }
      await audit(u.id, "PEDIDO_CRIADO", "pedido " + id + " campanha " + campId + " números " + lista.join(",") + " total " + total, ctx.ip);
      return { id, total };
    });
    try {
      const o = await mp.criarOrder({ ref: publicId, totalCentavos: pedido.total, email: u.email });
      const pm = o && o.transactions && o.transactions.payments && o.transactions.payments[0] && o.transactions.payments[0].payment_method || {};
      if (!RE_MP_ID.test(String(o.id || ""))) throw new Error("resposta sem id de order");
      // Diagnóstico do Pix (sem segredos e sem o código completo): mostra o que o Mercado Pago devolveu e se o "copia e cola" é um BR Code íntegro.
      console.log("[pix] order criada status=" + String(o.status || "").slice(0, 30) + " detalhe=" + String(o.status_detail || "").slice(0, 40) + " metodo=" + String(pm.id || "?").slice(0, 20) +
        " qr_tamanho=" + (typeof pm.qr_code === "string" ? pm.qr_code.length : "AUSENTE") + " qr_crc_ok=" + brcodeOk(pm.qr_code) + " qr_inicio=" + (typeof pm.qr_code === "string" ? pm.qr_code.slice(0, 14) : "-"));
      await db.run("UPDATE pedidos SET mp_order_id=?, mp_status=?, qr_code=?, qr_code_base64=?, ticket_url=?, atualizado_em=? WHERE id=?", [
        o.id, String(o.status || "").slice(0, 40), typeof pm.qr_code === "string" && pm.qr_code.length < 1500 ? pm.qr_code : null,
        typeof pm.qr_code_base64 === "string" && pm.qr_code_base64.length < 40000 && B64.test(pm.qr_code_base64) ? pm.qr_code_base64 : null,
        typeof pm.ticket_url === "string" && HOST_OK.test(pm.ticket_url) ? pm.ticket_url : null, agora(), pedido.id]);
    } catch (e) {
      console.error("Falha ao criar order no Mercado Pago:", e.message);
      await tx(async () => { await db.run("UPDATE pedidos SET status='FAILED', atualizado_em=? WHERE id=? AND status='PENDING'", [agora(), pedido.id]); await db.run("DELETE FROM reservas WHERE pedido_id=?", [pedido.id]); });
      throw new Erro("Não foi possível gerar o Pix agora. Seus números foram liberados; tente novamente em instantes.", 502);
    }
    return publico(await db.get(SEL + " WHERE p.id=?", [pedido.id]));
  }, "user"],

  /* Pedidos do próprio usuário (nunca de outro: filtro por user_id no SQL) */
  ["GET", /^\/api\/pedidos$/, async ctx => { await tx(() => liberar()); return (await db.all(SEL + " WHERE p.user_id=? ORDER BY p.id DESC LIMIT 30", [ctx.user.id])).map(publico); }, "user"],
  ["GET", /^\/api\/pedidos\/([a-f0-9]{32})$/, async ctx => {
    await tx(() => liberar()); const p = await db.get(SEL + " WHERE p.public_id=? AND p.user_id=?", [ctx.params[0], ctx.user.id]);
    if (!p) throw new Erro("Pedido não encontrado.", 404); return publico(p);
  }, "user"],
  /* "Já paguei": o servidor consulta o Mercado Pago (não confia em nada vindo do navegador) */
  ["POST", /^\/api\/pedidos\/([a-f0-9]{32})\/atualizar$/, async ctx => {
    limite("atual:" + ctx.user.id, 20, 6e4);
    const p = await db.get("SELECT id, mp_order_id, status FROM pedidos WHERE public_id=? AND user_id=?", [ctx.params[0], ctx.user.id]);
    if (!p) throw new Erro("Pedido não encontrado.", 404);
    if (p.mp_order_id && p.status === "PENDING") {
      let o; try { o = await mp.buscarOrder(p.mp_order_id); } catch (e) { console.error("consulta MP:", e.message); throw new Erro("Não consegui consultar o pagamento agora. Tente em instantes.", 502); }
      await aplicar(p.id, o);
    }
    return publico(await db.get(SEL + " WHERE p.id=?", [p.id]));
  }, "user"],

  /* Webhook do Mercado Pago: sem sessão e sem CSRF; a autenticidade vem da ASSINATURA */
  ["POST", /^\/api\/webhooks\/mercadopago$/, async ctx => {
    console.log("[webhook] requisição POST chegou (antes de validar)"); // se isto não aparece no Render, a requisição não chegou neste código
    if (!mp.configurado()) { console.error("[webhook] recusado 503: faltam MP_ACCESS_TOKEN e/ou MP_WEBHOOK_SECRET no ambiente"); throw new Erro("Indisponível.", 503); }
    limite("wh:" + ctx.ip, 600, 6e4);
    const h = ctx.req.headers, corpo = ctx.body && typeof ctx.body === "object" ? ctx.body : {};
    // Documentação: o id vem em ?data.id=ORD...&type=order. O corpo JSON ({type, data:{id}}) serve de reserva.
    const dataId = String(ctx.query["data.id"] || (corpo.data && corpo.data.id) || "");
    const tipo = String(ctx.query.type || corpo.type || "");
    if (!mp.assinaturaValida(h["x-signature"], h["x-request-id"], dataId)) {
      // log sem segredos: só diz o que chegou, para achar no Render por que foi recusado (segredo errado costuma ser a causa)
      console.warn("[webhook] REJEITADO 401 | x-signature:" + !!h["x-signature"] + " x-request-id:" + !!h["x-request-id"] + " data.id:" + !!dataId + " tipo:" + tipo.slice(0, 20));
      await audit(null, "WEBHOOK_REJEITADO", "assinatura inválida", ctx.ip); throw new Erro("Assinatura inválida.", 401);
    }
    console.log("[webhook] recebido tipo=" + tipo.slice(0, 20) + " acao=" + String(corpo.action || "").slice(0, 40) + " id=" + dataId.slice(0, 40));
    if (tipo !== "order" || !RE_MP_ID.test(dataId)) return { ok: true };   // outros tópicos (e a "simulação" do painel): ignorados com 200
    let o; try { o = await mp.buscarOrder(dataId); } catch (e) { console.error("webhook: consulta MP falhou:", e.message); throw new Erro("Falha ao consultar.", 502); } // 5xx = o MP tenta de novo
    let p = await db.get("SELECT id, mp_order_id FROM pedidos WHERE mp_order_id=?", [dataId]);
    if (!p && o && RE_PUBLIC.test(String(o.external_reference || ""))) {
      // O webhook pode chegar antes de gravarmos o mp_order_id (ou se essa gravação falhou). A referência é o nosso public_id aleatório.
      await db.run("UPDATE pedidos SET mp_order_id=? WHERE public_id=? AND mp_order_id IS NULL", [dataId, o.external_reference]);
      p = await db.get("SELECT id, mp_order_id FROM pedidos WHERE mp_order_id=?", [dataId]);
    }
    if (!p) { await audit(null, "WEBHOOK_PEDIDO_DESCONHECIDO", dataId.slice(0, 40), ctx.ip); return { ok: true }; }
    const status = await aplicar(p.id, o);
    console.log("[webhook] pedido " + p.id + " -> " + status);
    return { ok: true };
  }, "webhook"],

  /* Administração: pedidos e reembolsos pendentes */
  ["GET", /^\/api\/admin\/pedidos$/, async () => {
    await tx(() => liberar());
    return { receita: (await db.get("SELECT COALESCE(SUM(total_centavos),0) n FROM pedidos WHERE status='PAID'")).n / 100,
      pedidos: await db.all("SELECT p.public_id id, p.status, (p.total_centavos/100.0)::float8 total, p.numeros, p.criado_em, p.pago_em, p.mp_order_id, c.premio, u.nome, u.email FROM pedidos p JOIN campaigns c ON c.id=p.campaign_id JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 200") };
  }, "admin"],
  ["POST", /^\/api\/admin\/pedidos\/([a-f0-9]{32})\/reembolsado$/, async ctx => { // o admin devolve o dinheiro no painel do Mercado Pago e marca aqui
    const r = await db.run("UPDATE pedidos SET status='REFUNDED', atualizado_em=? WHERE public_id=? AND status='REFUND_NEEDED'", [agora(), ctx.params[0]]);
    if (!r.changes) throw new Erro("Pedido não está aguardando reembolso.");
    await audit(ctx.user.id, "PEDIDO_REEMBOLSADO", ctx.params[0], ctx.ip); return { ok: true };
  }, "admin"]
];
module.exports = { rotas, aplicar, interpretar, crc16, brcodeOk };