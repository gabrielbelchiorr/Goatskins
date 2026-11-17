# Segurança

## Contas e acesso

- Senhas usam scrypt com sal; tokens de sessão são armazenados como hash.
- Cookies de sessão usam HttpOnly, SameSite e Secure em produção.
- A conta é criada após a confirmação do código enviado por e-mail.
- Turnstile valida sucesso, hostname e ação no servidor. Falhas do provedor bloqueiam a operação.
- Todas as 19 rotas administrativas exigem sessão, papel ADMIN ou SUPER_ADMIN e MFA elevado. Promoções exigem SUPER_ADMIN.
- MFA usa senha atual e TOTP ou código de recuperação de uso único; a elevação gira o token de sessão. Preserve `MFA_ENCRYPTION_KEY` entre deploys. Veja o [guia de administração](../MFA_ADMINISTRACAO.md).
- Escritas autenticadas revalidam a sessão depois de adquirir a trava da transação; ações administrativas também revalidam papel e MFA antes do commit.
- Limites de tentativas protegem autenticação e ações sensíveis.

## Requisições e dados

Consultas SQL usam parâmetros. A aplicação valida corpo, tamanho, origem e cabeçalhos das requisições. CSP, HSTS em produção, bloqueio de iframe e nosniff restringem o uso do navegador. Somente arquivos autorizados são servidos publicamente.

Credenciais ficam no ambiente do servidor e não devem aparecer no frontend, nos logs ou no repositório.

## Sorteios e pagamentos

O servidor calcula preços e valida permissões. Transações e restrições únicas protegem números e reservas contra duplicidade. O vencedor é definido e gravado no servidor; a roleta apresenta o resultado salvo. Compromissos criptográficos publicados não são regenerados para contornar uma semente perdida ou inconsistente.

O webhook Pix exige assinatura e consulta autenticada ao Mercado Pago, com conferência de valor e referência. Comprovantes enviados pelo comprador não confirmam pagamento. Veja [operação de pagamentos](pagamentos.md).

## Manutenção

Revise atualizações de dependências, logs administrativos, certificados e backups. A suíte completa usa banco local descartável. Os [comandos de teste](testes.md) e o [mapa da arquitetura](arquitetura.md) documentam os pontos de manutenção. Testes locais não substituem a conferência das configurações dos provedores e da infraestrutura.
