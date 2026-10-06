# GOATSKINS – sorteios de skins com números pagos via Pix

Node.js 22.13+ com **PostgreSQL** (única dependência: a biblioteca `pg`). Cada sorteio tem um **preço por número** (0 = grátis) cobrado por **Pix via Mercado Pago (Orders API)**.

## Rodar
1. Instale o Node.js (LTS, 22.13 ou mais novo) e rode `npm install`.
2. Tenha um PostgreSQL local. Exemplo com Docker: `docker run --name goatskins-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=goatskins -p 5432:5432 -d postgres:16`
3. Copie `.env.example` para `.env` e confira o `DATABASE_URL` (o padrão já aponta para o Docker acima).
4. Crie o SUPER_ADMIN: `node --no-warnings server.js criar-admin seuemail@x.com SuaSenha123 "Seu Nome"` (as tabelas são criadas automaticamente na primeira execução)
5. Inicie: `npm start` e abra http://localhost:3000
6. Testes: `npm test`. Se houver testes em `tests/`, use um banco de teste separado em `DATABASE_URL` (nunca o de produção).
7. Backup: `npm run backup` (usa `pg_dump`, precisa do cliente PostgreSQL instalado).
8. Vindo do SQLite antigo: `DATABASE_URL=... npm run migrar-sqlite -- caminho/goatskins.db` (veja "Migrar do SQLite").

Sem serviço de e-mail configurado, os e-mails (confirmação, recuperação de senha) aparecem em `data/emails.log`: copie o link de lá.

## Estrutura
```
server.js          servidor HTTP, roteador, arquivos estáticos
src/config.js      variáveis de ambiente (.env)
src/db.js          PostgreSQL (pool), migrações versionadas, transações, auditoria
src/auth.js        cadastro, login, sessão, e-mail, senha, conta, notificações
src/rifas.js       listagem pública, escolha de números, sorteio verificável
src/admin.js       painel: dashboard, usuários, logs, sorteios, aparência
src/mail.js        envio de e-mail (console ou Resend)
src/http.js        validação, limite de tentativas, utilidades
public/            site (HTML, CSS, JS, termos, privacidade)
tests/api.test.js  testes automáticos
scripts/backup.js  backup do banco (pg_dump)
scripts/migrar-sqlite.js  copia os dados do SQLite antigo para o PostgreSQL
```

## Banco de dados (PostgreSQL)
```
users ──< sessions            users(id, nome, email*, telefone, hash, role USER|ADMIN|SUPER_ADMIN, status,
users ──< tokens_email                email_verificado, falhas, bloqueado_ate, consentimento_em, criado_em...)
users ──< notifications       campaigns(id, premio, desgaste, descricao, valor, max, max_por_usuario, status OPEN|CLOSED|DRAWN,
users ──< tickets >── campaigns        seed (secreta), commit_hash (pública), criado_por, criado_em...)
campaigns ──1 winners         tickets(campaign_id, user_id, n, criado_em)  UNIQUE(campaign_id, n)  <- impede número repetido
audit_logs, settings          winners(campaign_id, user_id, n, total, snapshot_hash, seed_revelada, metodo, sorteado_em)
```
Índices em tickets (campanha/número e usuário), sessions, tokens, notificações, logs e status. Migrações automáticas ao iniciar (tabela `schema_migrations`; novas alterações entram como novos itens no array `MIGRACOES` de `src/db.js`).
Datas continuam como texto ISO (como no SQLite) para manter o código simples.
**Concorrência:** cada transação (`tx`) pega uma trava de escrita do PostgreSQL (`pg_advisory_xact_lock`), o equivalente ao `BEGIN IMMEDIATE` do SQLite: as checagens de limite e reserva rodam uma por vez. A garantia final contra número repetido continua sendo `UNIQUE(campaign_id, n)` em `tickets` e a chave primária de `reservas`.

## Migrar do SQLite
1. Tenha o arquivo `goatskins.db` antigo (versão 4 do esquema; se estiver mais antigo, abra a versão SQLite do sistema uma vez para atualizar).
2. Com o PostgreSQL de destino **vazio**: `DATABASE_URL="<url>" npm run migrar-sqlite -- caminho/goatskins.db` (para o banco do Render, use a **External Database URL** no seu computador).
3. O script copia usuários, admins, sorteios, números, ganhadores, pedidos, reservas, notificações, auditoria e aparência, mantém os ids, acerta as sequências e confere as contagens. Roda numa transação (falhou = nada gravado). Sessões de login não são copiadas: todos entram de novo.

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
- Frontend e backend saem juntos: o próprio Node serve a pasta `public`. O banco agora é um PostgreSQL separado, então o servidor não precisa de disco persistente.
- **Render:** Build Command `npm install`, Start Command `npm start`. Variáveis: `NODE_ENV=production`, `APP_URL=https://seu-app.onrender.com`, `TRUST_PROXY=1`, `DATABASE_URL` (Internal Database URL do PostgreSQL do Render), mais as de e-mail e Mercado Pago. Em produção o servidor se recusa a subir sem `DATABASE_URL` válida.
- **VPS própria:** instalar Node 22+ e PostgreSQL, criar `.env`; rodar com `pm2` ou `systemd`; colocar o **Caddy** na frente (HTTPS automático); apontar o domínio para o IP.
- Backup: use os backups do serviço de banco (confira o que o seu plano do Render inclui) e/ou `npm run backup` (`pg_dump`, arquivos em `data/backups/`). Restaurar = `pg_restore --clean --no-owner -d "<url>" arquivo.dump`.
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
