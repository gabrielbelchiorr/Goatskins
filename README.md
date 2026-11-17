# GOATSKINS

Site de sorteios de skins com cadastro por e-mail, painel administrativo e pagamento por Pix pelo Mercado Pago.

## Desenvolvimento

Requisitos: Node.js 22.13 ou superior e PostgreSQL.

1. Execute `npm ci`.
2. Copie `.env.example` para `.env` e configure os serviços.
3. Crie o administrador: `node --no-warnings server.js criar-admin email@exemplo.com SuaSenha123 "Seu Nome"`.
4. Execute `npm start` e abra `http://localhost:3000`.

As migrações rodam ao iniciar. Com `EMAIL_DRIVER=console`, os e-mails locais ficam em `data/emails.log`.

## Estrutura

```text
public/       páginas, estilos, imagens e JavaScript do navegador
src/          autenticação, sorteios, pagamentos e acesso ao banco
scripts/      backup, migração e verificações
tests/        testes automatizados e auxiliares
previews/     prévias locais de carregamento e roleta
docs/         configuração e operação
server.js     servidor HTTP e rotas
```

## Testes

- `npm run test:unit`: testes sem banco.
- `npm test`: suíte geral; testes que precisam de banco são ignorados quando ele não está configurado.
- `npm run test:ci`: suíte completa com `TEST_DATABASE_URL` apontando para um PostgreSQL local descartável chamado `goatskins_test`.
- `npm run test:security:rigorous`: suíte completa com bloqueio de rede externa dos processos Node, inventário de rotas, consulta de dependências e evidências em `validation/`.

Os testes de integração apagam as tabelas do banco de teste. Não use o banco de produção.

## Documentação

- [Configuração e publicação](docs/configuracao.md)
- [Arquitetura e mapa do repositório](docs/arquitetura.md)
- [Testes e ferramentas locais](docs/testes.md)
- [Segurança](docs/seguranca.md)
- [Operação de pagamentos](docs/pagamentos.md)
- [Visualização 3D e predefinições de sorteios](docs/skins-3d-predefinicoes.md)
- [Redesign premium: componentes, validação e capturas](docs/redesign-premium.md)
- [Refinamento visual atual: sidebar, banner e cards](docs/refinamento-visual.md)

Relatórios detalhados de auditoria, pentest e revisões ficam fora deste repositório público (ver `.gitignore`). Os guias acima descrevem a configuração e a operação atuais.

As prévias `previews/loading.html` e `previews/roleta.html` funcionam sem servidor. O simulador Pix roda com `node scripts/mp-preview-local.js` e não processa pagamentos reais.

## Banco de dados

`npm run backup` cria um backup com `pg_dump`. A verificação usa `pg_restore`; ambos precisam estar instalados. Mantenha as cópias fora do disco efêmero da hospedagem e teste a restauração em banco separado.

Para migrar uma base SQLite antiga para um PostgreSQL vazio, use `npm run migrar-sqlite -- caminho/goatskins.db`, com `DATABASE_URL` definido para o destino. A migração preserva dados e IDs, mas exige novo login.
