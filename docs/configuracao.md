# Configuração

Use `.env.example` como referência. Credenciais ficam no `.env` local ou nas variáveis da hospedagem.

## Serviços

- PostgreSQL: configure `DATABASE_URL`. As migrações rodam ao iniciar. `DATABASE_SSL` e `DATABASE_CA` permitem ajustar TLS. Fora de produção, `npm start` recusa um `DATABASE_URL` remoto (por exemplo, a External URL do Render): o processo local executaria a fila de recuperação de senha e a varredura Pix sobre usuários reais. Use um PostgreSQL local; `PERMITIR_BANCO_REMOTO=1` libera o uso consciente. `criar-admin` não é afetado.
- Arquivos públicos: o servidor calcula um hash por arquivo, aplica `?v=<hash>` nos CSS/JS das páginas e serve Brotli/gzip com ETag. Não é preciso versionar `?v=` manualmente. Um arquivo novo em `public/` só é servido depois de entrar na allowlist `PUBLICOS` de `server.js`.
- Compartilhamento e busca: `APP_URL` define as URLs canônicas, `og:image`, `robots.txt` e `sitemap.xml`. Links `/?sorteio=ID` recebem título, descrição e foto do sorteio para WhatsApp, Instagram e outras redes.
- E-mail: configure `EMAIL_DRIVER=resend`, `EMAIL_API_KEY` e `EMAIL_FROM` com remetente verificado. Mantenha `EMAIL_CODE_SECRET` igual entre instâncias; trocá-lo invalida códigos pendentes.
- MFA administrativo: configure `MFA_ENCRYPTION_KEY` com 32 bytes aleatórios em hexadecimal, distintos do segredo de e-mail. Preserve a mesma chave entre instâncias/deploys e seu backup seguro; não a regenere automaticamente. Cada administrador precisa cadastrar o próprio autenticador conforme o [guia de MFA](../MFA_ADMINISTRACAO.md).
- Turnstile: configure `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` e os domínios autorizados no widget. `TURNSTILE_HOSTNAMES` permite definir aliases.
- Visualização 3D: configure a chave pública `CS2INSPECT_EMBED_KEY` e autorize os hosts utilizados no painel do provedor. Consulte [CS2Inspect](cs2inspect.md).
- Pix: configure `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET`. O webhook é `/api/webhooks/mercadopago`, com evento Order. `PIX_MINUTOS` define a validade da cobrança.

A janela de checkout é de cinco minutos. A cobrança Pix pode continuar pagável por mais tempo; o sistema mantém os números reservados até confirmar o cancelamento ou outro estado terminal no provedor. Uma indisponibilidade não autoriza liberação manual de números.

Para gerar um segredo de 32 bytes:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

O cadastro exige celular brasileiro com DDD, normalizado para `+55...`. Não há envio de SMS nem verificação de posse. Números repetidos são permitidos.

## Render

- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/healthz`
- `NODE_ENV=production`
- `APP_URL=https://goatskins.com.br`
- `DATABASE_URL`: conexão interna do PostgreSQL
- `TRUST_PROXY=1`; ajuste `TRUST_PROXY_HOPS` conforme a infraestrutura

Configure também as variáveis dos serviços acima. `TESTE` e `MP_TESTE_APRO` devem permanecer desativados em produção.

Cadastre o domínio e os registros DNS indicados pelo Render e confira o certificado HTTPS. Autorize o domínio no Turnstile. O deploy acompanha a branch `main` quando a publicação automática estiver habilitada.

`ORIGIN_VERIFY_SECRET` é opcional. Ative somente depois de configurar o proxy Cloudflare e uma regra que sobrescreva `x-goatskins-origin` com o mesmo segredo em todas as requisições. Ativá-lo antes bloqueia o site. `/healthz` permanece acessível ao monitor do Render.

## Verificação

Execute a [suíte completa](testes.md) com banco descartável antes de publicar. Depois, confira `/healthz` e os arquivos públicos. No Render, o health check informa o commit ativo no header `X-Goatskins-Revision`, quando `RENDER_GIT_COMMIT` é um SHA válido. Não use `/api/estado` como monitor: essa rota também executa reconciliação e limpeza de reservas.

Confira a retenção e a recuperação de backups na hospedagem. Para testes visuais locais, os scripts `verificar-cookies-ui.js` e `verificar-celular-ui.js` usam Chrome e Playwright, com APIs interceptadas. As capturas ficam em `validation/`.
