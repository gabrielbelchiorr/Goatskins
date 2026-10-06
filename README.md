# GOATSKINS – sorteios de skins com números pagos via Pix

Node.js 22.13+ puro, SQLite embutido, sem bibliotecas para instalar. Cada sorteio tem um **preço por número** (0 = grátis) cobrado por **Pix via Mercado Pago (Orders API)**.

## Rodar
1. Instale o Node.js (LTS, 22.13 ou mais novo).
2. (Opcional) copie `.env.example` para `.env` e ajuste.
3. Crie o SUPER_ADMIN: `node --no-warnings server.js criar-admin seuemail@x.com SuaSenha123 "Seu Nome"`
4. Inicie: `npm start` e abra http://localhost:3000
5. Testes: `npm test` (32 testes: cadastro, login, permissões, concorrência, sorteio, LGPD, admin, pedidos, webhook, pagamento duplicado/inválido/tardio). Os testes usam um Mercado Pago falso local: não precisam de credenciais.
6. Backup: `node --no-warnings scripts/backup.js`

Sem serviço de e-mail configurado, os e-mails (confirmação, recuperação de senha) aparecem em `data/emails.log`: copie o link de lá.

## Estrutura
```
server.js          servidor HTTP, roteador, arquivos estáticos
src/config.js      variáveis de ambiente (.env)
src/db.js          SQLite + migrações versionadas, transações, auditoria
src/auth.js        cadastro, login, sessão, e-mail, senha, conta, notificações
src/rifas.js       listagem pública, escolha de números, sorteio verificável
src/admin.js       painel: dashboard, usuários, logs, sorteios, aparência
src/mail.js        envio de e-mail (console ou Resend)
src/http.js        validação, limite de tentativas, utilidades
public/            site (HTML, CSS, JS, termos, privacidade)
tests/api.test.js  testes automáticos
scripts/backup.js  backup do banco
```

## Banco de dados (SQLite)
```
users ──< sessions            users(id, nome, email*, telefone, hash, role USER|ADMIN|SUPER_ADMIN, status,
users ──< tokens_email                email_verificado, falhas, bloqueado_ate, consentimento_em, criado_em...)
users ──< notifications       campaigns(id, premio, desgaste, descricao, valor, max, max_por_usuario, status OPEN|CLOSED|DRAWN,
users ──< tickets >── campaigns        seed (secreta), commit_hash (pública), criado_por, criado_em...)
campaigns ──1 winners         tickets(campaign_id, user_id, n, criado_em)  UNIQUE(campaign_id, n)  <- impede número repetido
audit_logs, settings          winners(campaign_id, user_id, n, total, snapshot_hash, seed_revelada, metodo, sorteado_em)
```
Índices em tickets (campanha/número e usuário), sessions, tokens, notificações, logs e status. Migrações automáticas ao iniciar (preservam dados antigos).

## API
Pública: `GET /api/estado`, `GET /api/campanhas/:id/verificacao`, `POST /api/registro|login|esqueci-senha|redefinir-senha`, `GET /api/verificar-email`
Logado: `POST /api/logout|reenviar-verificacao|campanhas/:id/numeros|conta/senha|conta/excluir`, `GET|PUT /api/conta`, `GET /api/notificacoes`
Admin: `/api/admin/dashboard|usuarios|logs|campanhas|visual`, `.../campanhas/:id/encerrar|sortear|participantes` (papel conferido no servidor)

## Sorteio auditável (commit-reveal)
1. Ao criar o sorteio o servidor gera uma semente secreta e publica só o **hash** dela (compromisso).
2. Depois do sorteio a semente é revelada. Vencedor = `números[HMAC-SHA256(semente, sha256(números)) mod N]`.
3. Qualquer pessoa confere em Histórico > "Ver prova".
Limite honesto: quem opera o servidor ainda decide *quando* encerrar. Para reduzir isso, o próximo passo seria misturar uma fonte externa (como o beacon público drand).

## Segurança implementada
scrypt + sal, comparação em tempo constante, cookie HttpOnly/SameSite, sessões com hash no banco e expiração, bloqueio por conta (5 falhas = 15 min) e por IP, CSRF por cabeçalho, consultas parametrizadas, validação de toda entrada, permissões no servidor (USER/ADMIN/SUPER_ADMIN), CSP e demais cabeçalhos, proteção contra path traversal, semente nunca exposta, logs de auditoria, nome do ganhador abreviado, exclusão de conta (LGPD), mínimo de dados (sem CPF).

## O que depende de você
- **E-mail real**: crie conta em resend.com, verifique seu domínio, gere a API key e coloque `EMAIL_DRIVER=resend`, `EMAIL_API_KEY=...`, `EMAIL_FROM=...` no `.env`.
- **Textos legais**: `public/termos.html` e `public/privacidade.html` são modelos; preencha o contato e peça revisão jurídica antes de qualquer uso real.

## Colocar no ar (versão gratuita e acadêmica)
- Frontend e backend saem juntos: o próprio Node serve a pasta `public`. Precisa de um servidor com **disco persistente** (por causa do SQLite): uma VPS pequena.
- Passos: instalar Node 22+, copiar o projeto, criar `.env` com `NODE_ENV=production`, `APP_URL=https://seudominio`, `TRUST_PROXY=1`; rodar com `pm2` ou `systemd`; colocar o **Caddy** na frente (HTTPS automático e gratuito); apontar o domínio (registro A) para o IP da VPS.
- Backup diário com `scripts/backup.js` (cron) e cópia dos arquivos para fora do servidor. Restaurar = parar o servidor e copiar o `.db` de volta para `data/goatskins.db`.
- Monitoramento gratuito: UptimeRobot apontando para `/api/estado`.
- Custo estimado (confira os preços atuais): domínio .com.br ≈ R$ 40/ano; VPS pequena ≈ R$ 25–60/mês; e-mail (Resend) tem plano gratuito para baixo volume; Caddy, HTTPS e UptimeRobot gratuitos. **Total aproximado: R$ 30–65/mês.**


## Pagamentos (Mercado Pago, Pix)
Fluxo: escolher números → `POST /api/campanhas/:id/pedidos` (o servidor lê o preço no banco, reserva os números numa transação e cria a Order Pix) → usuário paga → Mercado Pago chama `POST /api/webhooks/mercadopago` → o servidor valida a **assinatura**, **consulta a Order na API do Mercado Pago**, confere status/valor/referência e só então marca `PAID` e converte a reserva em número vendido.

- Estados do pedido: `PENDING`, `PAID`, `EXPIRED`, `CANCELED`, `FAILED`, `REFUND_NEEDED`, `REFUNDED`.
- Reserva = tabela `reservas` com chave primária (sorteio, número): o banco impede dois pedidos no mesmo número. Vence junto com o Pix (+5 min).
- Pagamento que chega depois da reserva vencer: se o número continua livre, é vendido; se não, o pedido vira `REFUND_NEEDED` (aparece em Admin > Pedidos para devolver no painel do Mercado Pago e marcar como reembolsado).
- Sorteio com Pix pendente não pode ser sorteado; preço não muda depois de haver vendas.
- Variáveis: `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `PIX_MINUTOS` (ver `.env.example`).
- Teste no sandbox: crie a Order com `payer.first_name = "APRO"` (ver doc do Mercado Pago) e confira que o webhook chega.
