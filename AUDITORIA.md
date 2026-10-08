# Auditoria pré-lançamento — GOATSKINS

Data: 06/10/2026. Escopo: todos os arquivos enviados (servidor, banco, pagamentos, autenticação, painel admin, frontend, testes, scripts).
**Veredito: NÃO PODE LANÇAR AINDA** — 3 pendências que o código sozinho não resolve (seção 5). O que dependia de código foi corrigido.

## 1. O que NÃO foi executado (leia primeiro)
Neste ambiente não havia PostgreSQL nem rede (`npm install` e `npm audit` impossíveis). Portanto:
- Os **47 testes de `tests/api.test.js` foram escritos mas NÃO executados**. Eles são os únicos que exercitam SQL real e concorrência real no PostgreSQL.
- Dois trechos de SQL novos nunca rodaram num PostgreSQL: a migração 2 (`src/db.js`) e o `UPDATE ... RETURNING` do login (`src/auth.js`). Revisados à mão (um erro de tipo no login foi achado e corrigido assim), mas só o teste real confirma.
- `npm audit` não rodou; não há `package-lock.json` (gere com `npm install` e versione-o; no Render use `npm ci`).
- O frontend foi checado só por sintaxe, não em navegador.

Executado e passando: **40 testes offline** (`npm run test:unit` + `tests/http.smoke.test.js`), incluindo os 11 de pagamento originais.

## 2. Achados e correções
| # | Gravidade | Achado | Correção |
|---|---|---|---|
| 1 | Alta | Força bruta em paralelo: o contador de falhas de login era "ler, somar no JS, gravar"; 200 tentativas simultâneas liam todas `falhas=0` e o bloqueio nunca disparava. | Tentativa **reservada atomicamente** no banco antes de conferir a senha (`auth.js`). No máximo 5 senhas por janela são testadas, mesmo em paralelo. |
| 2 | Alta | `scryptSync` travava o processo inteiro ~50–100 ms por login/cadastro: uma enxurrada de logins derrubava o site para todos. | `crypto.scrypt` assíncrono. Formato do hash guardado inalterado (senhas atuais continuam válidas). |
| 3 | Média | Pagamento tardio (Pix pago depois da reserva vencer) não respeitava o limite de números por pessoa. | Passa a cair em `REFUND_NEEDED` (`pedidos.js`). Teste novo. |
| 4 | Média | Admin editando/excluindo sorteio sem trava: podia mudar preço/vagas no meio de uma compra; reduzir vagas abaixo de números **reservados** deixaria um Pix pago sem número válido. | `PUT`/`DELETE` em transação com a mesma trava dos pedidos; confere também as reservas (`admin.js`). |
| 5 | Média | Limitador de tentativas era zerado a cada hora (quem estava bloqueado voltava a ter tentativas). | Poda só entradas expiradas (`http.js`). |
| 6 | Média | `GET /api/estado`, `/api/pedidos*` tomavam a **trava global de escrita** a cada chamada (inclusive o polling de 5 s do checkout). | `liberarSeVencido()` só entra na transação se existir reserva vencida; `estado` roda as consultas em paralelo e filtra reservas vencidas na leitura. |
| 7 | Média | Corpo de requisição de até 5 MB em qualquer rota (login, webhook...). | 100 KB fora de `/api/admin/*`. |
| 8 | Média | Produção/Render: `keepAliveTimeout` padrão (5 s) causa 502 esporádicos atrás do balanceador; `SIGTERM` podia travar esperando conexões; sem health check (README mandava monitorar `/api/estado`, pesada). | `keepAliveTimeout=65s`; desligamento limpo com limite de 15 s; **`/healthz`** (GET/HEAD, 503 se o banco cair). |
| 9 | Média | `inteiro()` usava `Number()` e aceitava `"1e2"`, `"0x10"`, `true`, `[5]`. | Só inteiros reais ou texto de dígitos. Achado pelo teste novo. |
| 10 | Média | `ipDe` usava sempre a **última** entrada do `X-Forwarded-For`. No Render, com mais de um proxy, todos podem parecer ter o mesmo IP (limites compartilhados, logs errados). | `TRUST_PROXY_HOPS` (padrão 1). **Verifique em Admin > Logs** (seção 5). |
| 11 | Média | `tests/api.test.js` ainda era da era SQLite (`node:sqlite`) e, com um `.env` apontando para produção, **gravaria usuários de teste no banco real**. | Reescrito para PostgreSQL; exige `TEST_DATABASE_URL` com "test" no nome; sem isso, "skipped". |
| 12 | Baixa | Excluir conta com Pix pendente ou reembolso a receber (sem e-mail não há como confirmar/devolver). | Bloqueado com 409. |
| 13 | Baixa | E-mail: faltava confirmação de pagamento e aviso de senha alterada; token de redefinição ia na query string (logs de proxy); `mail.js` sem timeout e sem criar `data/`. | E-mail de pagamento (após o commit, nunca derruba o webhook), aviso de senha alterada, link `/#redefinir=` (formato antigo ainda aceito), timeout de 10 s, `mkdir`. |
| 14 | Baixa | Banco: sem timeouts, sem CHECK de domínio, índices faltando. | `statement_timeout` 20 s, `idle_in_transaction_session_timeout` 30 s; **migração 2** com CHECKs `NOT VALID` (não reescreve nem barra dados antigos) e índices. |
| 15 | Baixa | Estáticos: arquivos ocultos (`.env`, `.git`) só eram barrados por acaso; HEAD → 405. | Dotfiles → 403; HEAD suportado. |
| 16 | Baixa | Backup: dump (e-mails, telefones, **sementes dos sorteios**) com permissão padrão; sem verificação. | `chmod 600`, `pg_restore --list` valida o dump, só apaga antigos depois de ter um novo válido. |
| 17 | Baixa | Frontend: clique duplo em "Gerar Pix"; sem Esc no modal; lista de pedidos não atualizava ao pagar; mensagens 429/5xx genéricas. | Corrigidos. |

**Verificado e sem problema** (não alterado): validação do webhook (HMAC + consulta da Order na API do MP + conferência de id/referência/valor), idempotência do `aplicar`, preço/total sempre do banco, reservas por chave primária, IDOR em pedidos (filtro por `user_id` no SQL), CSRF por cabeçalho + SameSite, ausência de CORS, XSS (o frontend só usa `textContent`), SQL parametrizado, sessões com hash no banco, semente nunca exposta antes do sorteio, `MP_TESTE_APRO`/`MP_API_BASE` travados em produção, erros 5xx genéricos.
**Fluxo de pagamento preservado:** `interpretar`, `assinaturaValida`, `criarOrder`, a criação do pedido/reserva e a rota do webhook não foram alteradas. Mudanças no fluxo: e-mail após o commit, limite por pessoa no pagamento tardio, e o modo de "liberar" nas leituras.

## 3. Arquivos
Alterados: `server.js`, `package.json`, `README.md`, `.env.example`, `.gitignore`, `src/{admin,auth,config,db,http,mail,pedidos,rifas}.js`, `scripts/backup.js`, `public/{script.js,index.html}`, `tests/{api,pagamentos}.test.js`.
Novos: `tests/unit.test.js`, `tests/http.smoke.test.js`, `tests/helpers/pg-falso.js`, `AUDITORIA.md`.
Sem alteração: `src/mercadopago.js`, `scripts/migrar-sqlite.js`, `public/{style.css,termos.html,privacidade.html}`. (O zip não inclui `public/logo.jpg`: mantenha o seu.)

## 4. Testes
- Offline, executados: 20 de pagamento/webhook (11 originais + 9 novos: pagamento tardio em 4 cenários, e-mail único, order de outro pedido, valor/idempotência no MP), 12 de smoke HTTP, 8 unitários. **40/40 passam.**
- Escritos e **não executados** (precisam de PostgreSQL de teste): 47 de API, incluindo os 32 originais portados e 15 novos de usuário malicioso (login paralelo, mass assignment, números repetidos/forjados, hierarquia ADMIN/SUPER_ADMIN, pedidos concorrentes do mesmo usuário e com números sobrepostos, vazamento de dados, injeção de SQL, conta suspensa, exclusão com Pix pendente, migração 2).

## 5. Pendências (o código não resolve)
🔴 **Bloqueadores**
1. **Rodar `npm run test:api` num PostgreSQL de teste** e corrigir o que aparecer. Sem isso, a migração 2 e o novo login não foram provados.
2. **Base legal.** Sorteio de prêmio com número vendido, operado por empresa privada, pode exigir autorização (ex.: Lei 5.768/71 e normas do Ministério da Fazenda) ou ser enquadrado como jogo de azar. Os Termos ainda têm `[PREENCHER ...]` e a Privacidade não tem o e-mail do responsável. Consulte um advogado **antes** de cobrar usuários reais. (Não sou advogado; isto é um alerta, não parecer.)
3. **Backups do banco.** Confirme no seu plano do Render que existe backup automático e restauração testada (planos gratuitos costumam ter limitações ou expirar). O `npm run backup` grava em `data/`, que no Render é descartado a cada deploy: copie os dumps para fora. Faça um teste de restauração.

🟡 **Atenção**
- Verifique o IP real em Admin > Logs; se todos iguais, `TRUST_PROXY_HOPS=2`.
- Sorteio verificável: quem opera o servidor conhece a semente e decide quando encerrar/sortear (já dito no README). A prova mostra que o resultado não foi alterado depois, não que o operador não escolheu o momento.
- Limite "N números por pessoa" é contornável com várias contas/e-mails.
- 5 senhas erradas por qualquer pessoa bloqueiam a conta da vítima por 15 min (troca consciente: segurança × disponibilidade).
- Limitador em memória: vale para 1 instância. Reembolsos são manuais (marcar no painel depois de devolver no Mercado Pago).
- CSP mantém `style-src 'unsafe-inline'`. SSL do banco usa `rejectUnauthorized:false` (normal no Render externo, aceitável na Internal URL).
- Se a criação da Order no MP der certo e a gravação local falhar, sobra um Pix órfão; se for pago, o webhook trata (vende ou manda para reembolso).

## 5.1 Configuração manual
Render: `NODE_ENV=production`, `APP_URL=https://...`, `TRUST_PROXY=1`, `DATABASE_URL` (Internal), `EMAIL_DRIVER=resend` + `EMAIL_API_KEY` + `EMAIL_FROM` (domínio verificado), `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`; *Health Check Path* = `/healthz`. Depois do deploy: conferir `[mp] pagamentos ativos` no log, fazer um Pix real de valor mínimo e conferir o e-mail de confirmação. Se o provedor de e-mail ainda não envia a clientes reais, o e-mail de pagamento/verificação não chegará.

## 6. Classificação final
🟢 Webhook/assinatura, idempotência, preço no servidor, reservas, IDOR, CSRF/XSS/SQLi, sessões, cabeçalhos.
🟡 IP atrás do proxy, limites em memória, sorteio verificável, contas múltiplas, reembolso manual.
🔴 Testes de API em PostgreSQL ainda não executados; base legal; backups.

**NÃO PODE LANÇAR AINDA.** Depois de (1) `npm run test:api` verde, (2) revisão jurídica e Termos preenchidos, (3) backup confirmado e restauração testada, o veredito do código passa a ser "pode lançar".
