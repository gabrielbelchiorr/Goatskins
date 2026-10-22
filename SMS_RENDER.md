# Celular obrigatório, sem SMS

Este documento substitui as instruções anteriores de Twilio. **Twilio não é necessário:** não há provedor SMS, códigos, reenvio, confirmação de posse ou variáveis de credenciais SMS.

O cadastro exige celular brasileiro com DDD e confirma o e-mail pelo fluxo existente. O backend valida DDD, tamanho e prefixo de celular, normalizando para E.164 (`+55...`). Máscara não substitui validação.

Para participar, reservar números ou criar pagamentos, a conta precisa de e-mail confirmado e celular em formato válido. `celular_verificado` não participa dessa autorização e não é ativado pelo preenchimento. Celulares repetidos são permitidos: um número informado não comprova identidade ou posse e não garante uma conta por pessoa. Não é usado para recuperar senha nem como substituto do MFA.

Contas antigas preservam login, senha, papel e histórico. Celulares brasileiros válidos já existentes são aceitos; quando o dado estiver ausente ou inválido, o usuário é direcionado ao preenchimento antes de participar. O número completo permanece privado, fora do estado público e dos logs. O perfil permite corrigir o celular sem alegar verificação de posse; alteração de um número antes confirmado remove o status antigo. E-mail, Turnstile no cadastro/login e MFA administrativo permanecem com as proteções atuais.

## Render e banco

Não é preciso contratar, configurar ou pagar por SMS. Variáveis `TWILIO_*` e `SMS_*` antigas podem ser removidas do painel do Render: a aplicação não as lê. Mantenha as configurações existentes de PostgreSQL, Resend, Turnstile, proxy/HTTPS e MFA. Girar a roleta exige sessão de administrador, sem confirmação MFA adicional; as demais rotas administrativas continuam com MFA.

As migrações anteriores permanecem intactas. A nova migração **7** remove somente o índice de exclusividade do celular confirmado. Não remove usuários, colunas, registros de verificação ou histórico; não confirma celulares automaticamente. As colunas e a tabela antigas ficam preservadas, sem fluxo SMS ativo.

O mecanismo versionado existente aplica essa migração ao iniciar uma implantação autorizada. Os testes usam exclusivamente PostgreSQL local descartável; não execute a suíte contra produção.

## Testes

Use exclusivamente PostgreSQL local descartável chamado `goatskins_test`, definido em `TEST_DATABASE_URL`. Rode `npm run test:ci` ou `node --test tests/phone.test.js tests/migrations.test.js`. A suíte valida números ausentes/inválidos, E.164, duplicidade permitida, legado, privacidade, APIs e preservação dos dados.

Para conferir o frontend: `node scripts/verificar-celular-ui.js`, com Chrome instalado e Playwright disponível (`npm install --no-save --package-lock=false playwright`). As APIs e a navegação ao grupo são interceptadas localmente; não há acesso a provedor SMS. O teste cobre cabeçalho, WhatsApp, máscara e preenchimento em desktop e celular.
