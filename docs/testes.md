# Testes e ferramentas locais

Use Node.js 22.13 ou superior; o CI usa Node.js 24 e PostgreSQL 16. Instale as dependências pelo lockfile com `npm ci`. O banco de teste precisa ser local, exclusivo e descartável, com nome exato `goatskins_test`. Não utilize o banco operacional nem uma cópia de dados pessoais reais.

## Comandos

| Comando | Finalidade |
| --- | --- |
| `npm run test:unit` | Regras e utilitários sem PostgreSQL real. |
| `npm test` | Suíte geral; testes dependentes de banco podem ser ignorados sem configuração. |
| `npm run test:api` | Seleção de integração HTTP/migrações/admin com PostgreSQL real. |
| `npm run test:ci` | Suíte completa; exige explicitamente o banco de teste validado. |
| `npm run test:security:local` | Seleção de cenários de segurança locais. |
| `npm run test:security:rigorous` | Suíte completa com evidências, inventário, advisories e isolamento adicional de processos Node. |
| `npm run audit` | Consulta de vulnerabilidades conhecidas nas dependências de produção. |
| `node scripts/verificar-segredos.js` | Heurísticas sobre textos versionados, sem imprimir valores encontrados. Não cobre todos os formatos/histórico. |
| `node scripts/security-route-inventory.js` | Regenera o inventário sem iniciar servidor, carregar `.env` ou consultar o banco. |
| `node scripts/verificar-redesign-ui.js --after` | QA do redesign com Chrome/Edge por CDP, sete larguras e fixtures locais; sem Playwright ou banco. |
| `node scripts/comparar-estilos.js --referencia=<pasta>` | Regressão de CSS: compara o estilo computado de cada elemento (e pseudo-elementos) entre uma cópia antiga de `public/` e a atual, em 34 telas/estados por largura, com Chrome local e fixtures. Use antes de reorganizar ou remover regras de `style.css`. |
| `node scripts/verificar-redesign-ui.js --http-only` | Entrega dos novos assets pela allowlist do servidor real, usando banco falso local. |

Exemplo PowerShell, substituindo os dados fictícios pelos de sua instância descartável:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://USUARIO:SENHA@127.0.0.1:PORTA/goatskins_test'
npm run test:security:rigorous -- --output validation/execucao-local
```

`npm test`, `test:ci` e `test:security:rigorous` executam somente `tests/**/*.test.js`. Cópias antigas de testes guardadas em `validation/` não entram na suíte.

O guard rejeita hosts remotos, outro nome de banco e parâmetros adicionais na URL. Algumas suítes recriam o schema `public`; outras usam schemas próprios. A suíte geral executa os arquivos sequencialmente para preservar esse isolamento. Um teste ignorado não significa aprovação.

O runner rigoroso impede leitura de `.env` pelos leitores usados pela aplicação e conexões TCP/fetch fora de loopback nos processos Node. Mocks continuam simulando provedores; isso não é um sandbox do sistema operacional. A consulta de advisories é externa e separada dos testes da aplicação. Resultados e hashes ficam em `validation/`, que é ignorado pelo Git.

## Navegador e prévias

As mudanças visuais atuais e evidências da revisão de 4 de novembro de 2026 estão em [Refinamento visual e sidebar](refinamento-visual.md). Os relatórios e capturas gerados pelo verificador ficam em `validation/visual-refinement/`; os dados das capturas são fixtures e não campanhas comerciais. As imagens necessárias ao QA estão em `tests/fixtures/skins/`.

- Os testes com `browser` no nome usam Chrome/Edge local por CDP. É possível definir `SECURITY_AUDIT_BROWSER` para informar o executável. O perfil é temporário e a rede é restrita às fixtures locais; a ausência do navegador gera skip explícito.
- `scripts/verificar-conta-ui.js`, `verificar-celular-ui.js`, `verificar-cookies-ui.js` e `verificar-mfa-ui.js` são QA visual opcional e exigem Playwright disponível no ambiente de ferramentas, além de Chrome. Não são iniciados pelo servidor nem pelo deploy.
- `previews/loading.html` e `previews/roleta.html` são prévias locais que compartilham assets e estilos com a aplicação.
- `node scripts/mp-preview-local.js` inicia um simulador de Pix local. Ele não efetua pagamentos reais e não deve ser exposto como serviço de produção.

## O que preservar ao alterar testes

As suítes cobrem autenticação, recuperação, MFA, hierarquia, CSRF, Turnstile, sessão, IDOR, sorteios, transações, Pix, assinaturas, idempotência e concorrência. Mocks genéricos e doubles de pagamentos têm estados e finalidades diferentes; semelhança textual não prova redundância.

Não trocar respostas esperadas por erros genéricos nem omitir asserções do banco para obter aprovação. Não usar `TESTE=1` como única evidência de rate limiting. Cenários que precisam descrever limites reais mantêm os controles ativos. Migrações e provas históricas precisam continuar cobertas.

Os workflows em `.github/workflows/` executam testes e verificação de dependências/segredos. CodeQL é manual e depende da configuração/permissões do repositório; não foi acionado por esta refatoração.
