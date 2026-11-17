# Arquitetura e mapa do repositório

A aplicação mantém Node.js e JavaScript sem framework, PostgreSQL e arquivos estáticos. `npm start` inicia `server.js`; as migrações e a preparação do banco terminam antes de o servidor aceitar requisições.

## Fluxo de uma requisição

1. `server.js` aplica cabeçalhos, limites de tamanho, proteção opcional da origem e roteamento.
2. `security.js` verifica CSRF, limites de admissão e Turnstile conforme a ação. O webhook se autentica pela assinatura do provedor.
3. `auth.js` resolve a sessão. Rotas administrativas passam também pela hierarquia e pelo MFA em `mfa.js`.
4. O handler valida campos e executa suas operações. `db.tx()` usa uma conexão transacional e trava advisory compartilhada; revalida autorização sob a trava e, nas operações administrativas, antes do commit.
5. A API responde JSON sem cache. Imagens públicas usam rotas próprias; arquivos estáticos precisam constar da allowlist de `server.js` e são entregues por `src/estatico.js`.

O inventário de rotas (`SECURITY_API_ROUTES.md`, mantido fora do repositório público) é gerado por `node scripts/security-route-inventory.js`. Uma referência que pareça ausente em imports pode existir no dispatcher, na allowlist, em `fetch`, em caminhos montados no navegador, em scripts npm ou em subprocessos de testes.

## Responsabilidades dos módulos

| Arquivo | Responsabilidade |
| --- | --- |
| `server.js` | Inicialização/encerramento, CLI `criar-admin`, dispatcher, recursos públicos e health check. |
| `src/config.js` | Configuração por ambiente e validação de requisitos de produção. |
| `src/db.js` | Pool PostgreSQL, consultas parametrizadas, transações, migrações históricas, reservas, auditoria e notificações. |
| `src/http.js` | Validação básica, erro HTTP, cookies, limites em memória e IP atrás de proxies confiáveis. |
| `src/security.js` | CSRF, Turnstile e limites de autenticação antes de chamadas externas. |
| `src/auth.js` | Login, sessões, senha, conta e notificações do usuário. |
| `src/registration.js` | Solicitação pendente, código de e-mail e limites persistentes de cadastro/envio. |
| `src/recovery.js` | Fila durável de recuperação de senha, leases, retries e cancelamento. |
| `src/mfa.js` | Provisionamento TOTP, cifra do fator, recuperação de uso único e elevação administrativa. |
| `src/phone.js` | Formato brasileiro de celular e atualização do perfil; não verifica posse por SMS. |
| `src/rifas.js` | Estado público, participação, prova criptográfica e sorteio. |
| `src/admin.js` | Gestão administrativa de usuários, campanhas, aparência, entregas e indicadores. |
| `src/pedidos.js` | Reservas Pix, reconciliação, expiração/cancelamento e aplicação de confirmação no banco. |
| `src/mercadopago.js` | Cliente Orders API e validação de assinatura. |
| `src/mail.js` | Resend ou console local; a fila de recuperação fica em `recovery.js`. |
| `src/estatico.js` | Entrega da allowlist pública: cache em memória, ETag/304, Brotli/gzip, `?v=<hash>` automático, bloco SEO por página, metadados de compartilhamento de `/?sorteio=ID`, `robots.txt`, `sitemap.xml` e `/favicon.ico`. Carregado sob demanda pelo `server.js`. |
| `public/prova.js` | Verificação do sorteio no navegador (Web Crypto) com o mesmo método de `rifas.calcularVencedor`; também importável no Node para testes. |

Alguns imports são tardios para resolver dependências entre autenticação, celular, recuperação, sorteios e pedidos. Não antecipá-los apenas para uniformizar o estilo. As migrações estão incorporadas em `db.js` e precisam ser preservadas, mesmo quando mencionam estruturas legadas.

## Frontend e caminhos dinâmicos

`public/index.html` carrega a folha de estilo única `style.css` (tokens do design system no cabeçalho do arquivo; ela substitui os antigos `roulette.css`, `skin-viewer.css`, `presets.css`, `premium.css` e `journey.css`, na mesma ordem de cascata), o loader, a interface principal, a roleta e o consentimento de cookies. `script.js` monta cards, formulários e modais; `roulette.js` anima o resultado gravado pelo servidor. Classes e URLs também são construídas em JavaScript.

Os assets `logo.jpg`, `logo-marca.webp`, `mascote.webp` e `cenario.webp` têm referências no HTML, no CSS ou no código. `logo.jpg` é o favicon e também participa de testes de arquivos públicos. As prévias de `previews/` referenciam `../public/`; não são páginas de produção.

## Integrações e operação

| Integração | Uso |
| --- | --- |
| Render | Build/start, variáveis, HTTPS e implantação. A branch `main` pode implantar automaticamente. |
| PostgreSQL | Fonte persistente de identidade, sorteios, pedidos, reservas, fila e auditoria. |
| Cloudflare | Proxy/origem conforme configuração operacional e Turnstile validado no servidor. |
| Mercado Pago | Orders API Pix, assinatura de webhook e consulta autenticada para confirmação/cancelamento. |
| Resend | E-mails transacionais; o modo console grava somente no ambiente local. |
| Twilio | Não há integração ativa. Celular válido não comprova posse; não são necessárias credenciais Twilio. |

Os dois pacotes de produção são `pg` e `qrcode-generator`. O QR do MFA é gerado localmente; não usa serviço externo. Ferramentas visuais Playwright são opcionais e não integram as dependências de produção. O teste de navegador por CDP usa Chrome/Edge local sem pacote adicional.

`scripts/backup.js` e `scripts/migrar-sqlite.js` são ferramentas operacionais. Não são módulos mortos por não serem importados pela aplicação. Backups e dados em `data/`, resultados em `validation/`, dependências instaladas e `.env` ficam fora do versionamento.

## Documentação atual e histórico

- [Configuração](configuracao.md), [segurança](seguranca.md), [pagamentos](pagamentos.md) e [testes](testes.md) são os guias atuais.
- [MFA](../MFA_ADMINISTRACAO.md) detalha configuração, recuperação e preservação da chave.
- Relatórios e inventários de auditoria na raiz guardam o contexto e as evidências de cada rodada. Não apagar resultados antigos para atualizar contagens ou pendências.
- Relatórios de auditoria e de revisão ficam fora do repositório público.
