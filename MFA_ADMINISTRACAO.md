# GOATSKINS — MFA obrigatório na administração

Implementação local de28/10/2026, sobre `be7e03b`. **Não publicada. Não foi acessado o domínio, banco ou credenciais de produção nesta etapa.** O push da branch main pode disparar Render. A publicação foi autorizada posteriormente pelo proprietário, mas permanece condicionada à configuração e verificação da chave no Render.

## O que foi reaproveitado e alterado

A implementação anterior a `dc4f42f` tinha TOTP, AES-GCM, limites SQL e rotação de sessão. A migração8 removeu a tabela/funções. Foram reaproveitados os algoritmos e os mecanismos atuais de sessão/transação/limites; não foi criada outra autenticação paralela.

Não foi restaurada a antiga exceção que dispensava MFA no sorteio. ADMIN e SUPER_ADMIN precisam de MFA em **todas as19 rotas administrativas**, inclusive GETs, sorteios e atestação financeira. O dispatcher também protege futuras rotas sob `/api/admin/`. Campos, headers, papel e flags de verificação enviados pelo navegador não concedem acesso.

Migração **10**, exclusivamente aditiva: recria `admin_mfa` e acrescenta `sessions.mfa_until`/`mfa_role`. Preserva contas, hashes de senha, sessões e dados comerciais. Sessões existentes começam sem elevação; os administradores configuram o fator antes de acessar o painel. Os segredos apagados pela migração8 não podem ser restaurados automaticamente.

## Configuração manual antes de qualquer implantação

1. No gerenciador de segredos/painel Render, configure **`MFA_ENCRYPTION_KEY`**: exatamente64 caracteres hexadecimais, correspondentes a32 bytes aleatórios. Use uma chave exclusiva, diferente das chaves de e-mail/pagamento e das fixtures de teste.
2. Gere a chave em um terminal privado e copie diretamente para o gerenciador, sem enviar em mensagens, capturas, Git ou logs compartilhados:

   ```powershell
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Mantenha a **mesma chave em todas as instâncias e entre deploys**. Guarde uma cópia segura separada do banco, com acesso restrito. Perder a chave impede decifrar os autenticadores; trocar a chave sem recifrar os registros não é uma rotação válida.
4. Confirme HTTPS, cookies Secure/HttpOnly, horário/NTP correto e acesso restrito à hospedagem. Ative MFA também nas contas operacionais Render/GitHub por seus fluxos próprios; esta implementação não configura esses serviços.
5. Execute `npm ci --ignore-scripts` e valide em staging isolado com dados sintéticos. A única dependência nova é **`qrcode-generator@2.0.4`**, sem dependências transitivas, para produzir o QR localmente. Não há serviço externo de QR, nova biblioteca de autenticação ou extensão PostgreSQL.
6. Revise backup/rollback, diff e resultados de testes antes de pedir uma futura implantação. A migração10 será aplicada pelo startup existente, depois de autorização. **Nada foi migrado em produção nesta entrega.**

Em produção a ausência/formato inválido da chave interrompe a inicialização, evitando publicar administração desprotegida. Em desenvolvimento o site público continua funcionando, mas MFA/admin sem chave válida retorna503; não existe bypass por `TESTE` ou flag de ambiente.

## Primeira configuração de cada administrador

1. Entre normalmente com a senha administrativa. Isso permite acessar a configuração, mas não libera o painel.
2. Confirme a senha para gerar o QR. No **Google Authenticator**, adicione uma conta por QR; no **Microsoft Authenticator**, use adicionar conta/“Outra conta”, conforme o aplicativo. Também é possível informar a chave manual.
3. O perfil é TOTP, SHA-1, seis dígitos, período30s, emissor GOATSKINS. Confirme novamente senha e um código do aplicativo para comprovar a posse do segredo.
4. Guarde os **oito códigos de recuperação**, exibidos apenas nessa ativação. Há cópia/download mediante ação explícita; não ficam no localStorage, cookies, URL ou logs. Guarde-os em local seguro, separado do dispositivo autenticador, e confirme o armazenamento na interface.
5. O servidor rotaciona a sessão, encerra as outras sessões na ativação e libera a administração por15minutos. A sessão elevada tem expiração absoluta de no máximo8horas. Após expirar a elevação, senha+TOTP ou senha+código de recuperação são exigidos novamente.

Cada administrador faz sua própria configuração. Novas promoções não recebem MFA automaticamente e as sessões anteriores são revogadas pelo fluxo de papéis existente. A primeira configuração pressupõe que o operador legítimo ainda controla a senha; faça-a em dispositivo confiável, principalmente após uma exposição de credenciais.

## Recuperação e limites

- Cada código tem128bits aleatórios; são armazenados apenas hashes SHA-256 com domínio e vínculo ao usuário. Não são senhas curtas suscetíveis a dicionário. Um código usado é removido atomicamente e encerra as outras sessões.
- TOTP só aceita o passo atual e um passo adjacente de30s. `last_step` monotônico, transação e trava por conta impedem consumir o mesmo passo em sessões concorrentes.
- Preparação expira em10min e é vinculada ao hash da sessão. Um fator já ativo não pode ser substituído por “preparar”. Pendências vencidas são limpas pelo job existente.
- Limites persistentes: **8 tentativas/10min por conta e40/10min por IP**, incluindo preparação e verificação; falhas não revertem a contagem. Continuam ativos nos testes e sobrevivem a reinícios. Respeite a janela após um bloqueio.
- Recuperação de senha por e-mail e o CLI `criar-admin` **não removem o fator configurado**. Não existe endpoint público para desativar MFA nem senha mestra.
- Para perda do telefone, escolha “Usar código de recuperação”. Com acesso ao aplicativo, continue usando TOTP; os códigos de emergência não são necessários em cada login.
- Perder o telefone e todos os códigos exige procedimento operacional de recuperação com verificação de identidade, acesso autenticado à hospedagem, backup, revogação integral de sessões e auditoria. Não foi criado um reset remoto de fator ou suporte que permita ignorar MFA. Planeje esse procedimento com os responsáveis antes da implantação; não apague linhas manualmente para contornar o controle.
- Não há substituição de autenticador nem regeneração de códigos pela interface nesta entrega. Se o fator/códigos precisarem ser substituídos, use procedimento operacional revisado; senha recuperada por e-mail não deve ser usada para autorizar essa substituição.

## Garantias e limites técnicos

Seed de160bits, criptografada em AES-256-GCM com nonce aleatório e AAD vinculada ao ID do administrador. A chave de cifragem permanece fora do banco. QR e URI são devolvidos somente na preparação autenticada, com `Cache-Control: no-store`; o QR é GIF gerado no servidor e não visita URL de terceiros.

Consumo TOTP/recovery, ativação, auditoria e rotação de sessão são atômicos. `Set-Cookie` só é emitido depois do commit. A elevação é vinculada ao papel atual; promoção, rebaixamento, suspensão, revogação ou expiração não podem reaproveitar a autorização anterior. Mutações administrativas também revalidam autorização após adquirir a trava e antes do commit, sem manter uma transação aberta durante I/O de provedor.

Os testes verificam o algoritmo contra vetores RFC e o formato de provisionamento usado pelos aplicativos. Não foi feito pareamento com aparelhos físicos. TOTP não oferece resistência a phishing em tempo real equivalente a uma chave de hardware/passkey. Não há certificação ASVS nem garantia de ausência de outras falhas.

## Rollback e preservação

Migração10 é aditiva; não é necessário apagar tabela, coluna ou usuários para reverter código. Entretanto, restaurar o código anterior elimina o gate obrigatório de MFA: trate isso como redução de segurança, com plano de contenção da administração. Não rotacione/apague a chave de cifragem durante rollback e não restaure um banco antigo sobre dados recentes.

Nenhum administrador foi criado/alterado em produção nesta tarefa. Credenciais e dados de testes são sintéticos, somente em PostgreSQL loopback descartável validado por `scripts/banco-teste.js`.

Referências: [RFC6238](https://www.rfc-editor.org/rfc/rfc6238), [formato otpauth Google](https://github.com/google/google-authenticator/wiki/Key-Uri-Format), [OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html), [ASVS5 V6](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md), [gerador QR](https://github.com/kazuhikoarase/qrcode-generator).

## Preparação para publicação — 28/10/2026

Após a autorização do proprietário, foi gerada uma chave criptograficamente aleatória e configurada somente no `.env` local, ignorado pelo Git. Uma cópia cifrada com Windows DPAPI foi guardada fora do repositório, em `%LOCALAPPDATA%/GOATSKINS/secrets/mfa-encryption-key.dpapi`, vinculada ao usuário Windows atual. Os valores não foram impressos nem incluídos no código ou nos relatórios. Essa cópia local não substitui um backup operacional independente e controlado.

O acesso ao Render ainda depende da instalação e conexão da integração pelo proprietário. A chave não foi cadastrada no serviço e a atualização não foi publicada. Antes de configurar, preservar qualquer chave válida que já exista no Render; não sobrescrever uma chave utilizada por fatores ativos. Só publicar após confirmar a configuração. O pareamento de cada administrador precisa ser concluído pelo próprio titular, com seu aparelho e os códigos de recuperação.
