Atualização de 22/10/2026: a autenticação em duas etapas da administração foi removida. O painel exige login por senha e permissões de administrador. MFA_ENCRYPTION_KEY não é mais usada. A migração 8 remove os segredos e campos antigos ao iniciar o servidor. Referências abaixo ao MFA do painel são históricas.

# GOATSKINS — o que fazer quando chegar em casa

Este pacote contém o projeto completo atualizado, incluindo as alterações da revisão anterior. O site publicado não foi alterado. Os arquivos vieram do GitHub no commit `089b9ea`; preserve qualquer alteração local feita depois dele.

## 1. Colocar os arquivos na sua pasta original

1. Faça uma cópia da sua pasta atual do projeto.
2. Extraia a pasta `GOATSKINS_atualizada` deste ZIP.
3. Copie o conteúdo dela para sua pasta original `GOATKSINS SITE OFICIAL`, substituindo os arquivos de mesmo nome. Inclua as pastas `public`, `src`, `scripts`, `tests` e `.github`.

Mantenha o `.env`, a pasta `.git` e seus dados existentes: eles não estão no pacote. Não troque suas chaves reais pelas linhas vazias do `.env.example`.

Para ver só o loading, abra `PREVIA_LOADING.html` na pasta extraída. É uma demonstração local; não precisa iniciar o servidor nem o banco.

Para conferir a nova roleta, abra `PREVIA_ROLETA.html`. Ela usa a mesma interface do site com nomes fictícios, permite conferir 24 ou 100 números e mostra o ganhador ao terminar. Não realiza sorteios reais. No site, **Girar roleta** abre a tela dedicada; **GIRAR ROLETA** inicia o sorteio. O Histórico permite reabrir o resultado sem sortear novamente.

## 2. Rodar os testes no PowerShell do VS Code

Na pasta original do projeto:

```powershell
npm.cmd ci
npm.cmd audit --omit=dev
```

Use o banco **local descartável `goatskins_test`** que você já configurou. Não use a URL do banco do Render: os testes apagam as tabelas do banco de teste.

```powershell
$credencialTeste = Get-Credential -UserName postgres -Message "Senha do PostgreSQL LOCAL de teste"
$env:TEST_DATABASE_URL = "postgresql://postgres:$([Uri]::EscapeDataString($credencialTeste.GetNetworkCredential().Password))@localhost:5432/goatskins_test"
npm.cmd run test:ci
```

Se houver falha, pare antes de publicar e traga o erro. No Windows, o teste específico de link simbólico pode ser ignorado; os testes de API, migração e MFA precisam executar. Não envie sua senha ou URL do banco.

## 3. Conferir Render e domínio

No serviço da GOATSKINS no Render, confira as variáveis abaixo. **Mantenha os valores secretos que já funcionam.**

| Variável | Valor ou ação |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_URL` | `https://goatskins.com.br`, depois de o domínio e o certificado estarem funcionando |
| `DATABASE_URL` | Internal Database URL do seu banco; manter a existente |
| `TRUST_PROXY` | `1`; conferir `TRUST_PROXY_HOPS` conforme os proxies reais |
| `EMAIL_DRIVER` | `resend` |
| `EMAIL_API_KEY` | Manter a chave real do Resend |
| `EMAIL_FROM` | Remetente do seu domínio verificado no Resend |
| `EMAIL_CODE_SECRET` | Manter o existente; se estiver ausente, gerar 32 bytes em hexadecimal |
| `MFA_ENCRYPTION_KEY` | Manter o existente; se estiver ausente, gerar outro segredo de 32 bytes em hexadecimal |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | As chaves reais do seu widget Managed |
| `TURNSTILE_HOSTNAMES` | Apenas aliases usados e autorizados no widget, por exemplo `www.goatskins.com.br,goatskins.onrender.com` |
| `ORIGIN_VERIFY_SECRET` | **Vazio inicialmente.** Ativar somente na etapa 6 |

`TESTE` e `MP_TESTE_APRO` não devem estar ligados em produção. Não altere `MFA_ENCRYPTION_KEY` se já há um autenticador configurado: ela cifra o segredo dele.

Domínio correto: `goatskins.com.br`. Confira o domínio no Render, os registros DNS indicados por ele e o certificado emitido. No Turnstile, autorize esse domínio e os aliases realmente utilizados. O novo código direciona documentos do `www` e outros aliases para `APP_URL` em produção, evitando criar sessões em origens diferentes.

Render: Build Command `npm ci`; Start Command `npm start`; Health Check Path `/healthz`.

## 4. Enviar ao GitHub e publicar

Depois de os testes passarem, na sua pasta original:

```powershell
git status
git add -- .env.example .github README.md SEGURANCA.md PUBLICAR_EM_CASA.md PREVIA_LOADING.html PREVIA_ROLETA.html package.json package-lock.json server.js public src scripts tests
git commit -m "Loading, nova roleta e melhorias de seguranca Cloudflare"
git push origin main
```

Esses comandos pressupõem que você está na branch `main` do seu projeto original. No Render, aguarde o deploy concluir e confira o log. Se o deploy falhar, corrija o erro de configuração mostrado; não desligue as validações de segurança para conseguir subir.

## 5. Conferir o site publicado

1. Abra `https://goatskins.com.br/healthz`: deve aparecer `ok`.
2. Abra `https://goatskins.com.br/api/seguranca`: deve retornar a chave pública do Turnstile, sem secrets.
3. Atualize a página: o loading deve aparecer brevemente e sair quando os sorteios carregarem. Confira no PC e no celular.
4. Faça um cadastro de teste com um e-mail seu: a conta só deve ser criada depois do código. Confira a entrega no Resend e na caixa de entrada.
5. Entre no administrador, cadastre/confirme o autenticador e guarde os códigos de recuperação.
6. Confira um Pix real pequeno e a confirmação pelo provedor. Atualize o webhook do Mercado Pago para `https://goatskins.com.br/api/webhooks/mercadopago` antes da etapa 6.
7. Confira o tamanho dos números, os botões e a apresentação do ganhador na prévia da roleta no PC e no celular. No site, os números mostrados precisam corresponder aos participantes e o resultado precisa coincidir com o Histórico e a prova. Não inicie um sorteio pago para apenas testar a aparência; use a prévia local.

A política de privacidade ainda precisa do contato do responsável pelo serviço. Preencha esse contato e revise o texto antes do lançamento.

## 6. Cloudflare completo e proteção da origem

Faça esta etapa depois de domínio, certificado, Turnstile e webhook estarem funcionando.

1. Se o DNS ainda está somente no Registro.br, coloque a zona do domínio na sua conta Cloudflare e use os nameservers que ela informar. Preserve os registros existentes, inclusive os de e-mail/Resend.
2. Coloque os registros web de `goatskins.com.br` e `www` no proxy Cloudflare. Confirme o certificado no Render e o modo de TLS apropriado, **Full (strict)** com certificado válido na origem.
3. Confira o WAF gerenciado disponível no seu plano. Não aplique desafio interativo/captcha ao webhook do Mercado Pago; a aplicação já exige assinatura e consulta ao provedor.
4. Gere **um novo segredo separado**, somente no seu computador:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

5. No Cloudflare, em **Rules → Transform Rules → Modify Request Header**, crie uma regra para os hosts da GOATSKINS. Expressão:

```text
http.host in {"goatskins.com.br" "www.goatskins.com.br"}
```

Operação **Set static**; nome `x-goatskins-origin`; valor: o novo segredo. É um header de **requisição**, enviado para o servidor. A regra deve sobrescrever o valor recebido. Não configure esse segredo como header de resposta e não coloque no JavaScript.

6. **Depois de a regra estar ativa**, adicione `ORIGIN_VERIFY_SECRET` no Render com exatamente o mesmo valor e aguarde o deploy/restart.
7. Confirme que o site e o webhook pelo domínio continuam funcionando. O acesso direto a `https://goatskins.onrender.com/api/seguranca` deve retornar 403, enquanto `/healthz` GET/HEAD permanece acessível ao monitor do Render.

Se ativar essa variável e o domínio passar a retornar 403, remova temporariamente **apenas `ORIGIN_VERIFY_SECRET`** do Render e corrija a regra/proxy. As demais proteções da aplicação continuam necessárias.

O header reduz o desvio do WAF na aplicação; não substitui isolamento de rede e não torna a origem imune a sobrecarga. O health check continua público por necessidade do Render.

Referências: [regra de header no Cloudflare](https://developers.cloudflare.com/rules/transform/request-header-modification/create-dashboard/) e [proteção da origem](https://developers.cloudflare.com/learning-paths/prevent-ddos-attacks/advanced/prevent-external-connections/).
