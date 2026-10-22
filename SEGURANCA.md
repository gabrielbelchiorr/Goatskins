# Segurança, loading, roleta e Cloudflare — GOATSKINS

Atualização de 22/10/2026: por escolha do responsável, somente a ação de girar a roleta dispensa MFA adicional. Ela mantém sessão válida, papel ADMIN/SUPER_ADMIN, CSRF, regras do sorteio e auditoria. As demais rotas administrativas seguem protegidas por MFA. A revisão histórica abaixo descreve a configuração anterior.

Revisão de 12/10/2026, a partir do commit `089b9ea`.
Referência enviada: [vídeo de Murilo Miguel](https://www.tiktok.com/@murilomiguelba/video/7694727532301569332).
O vídeo foi aberto e suas legendas examinadas; as recomendações foram adaptadas ao projeto Node.js/PostgreSQL.

## Comparação com o vídeo

| Recomendação | Situação |
| --- | --- |
| Políticas de cookies e privacidade | Privacidade já existente; acrescentada `/cookies.html` com links no rodapé e na privacidade. Descreve o armazenamento real. Não foi instalado Analytics ou rastreamento. |
| Trocar URL administrativa do WordPress | Não há WordPress ou `wp-admin`. A administração exige autorização no servidor por papel e MFA. Alterar nomes de rotas não substitui essas proteções. |
| Atualizar CMS e plugins | Sem CMS; instalação fixada pelo lockfile. Dependabot passa a propor atualizações de npm e GitHub Actions para revisão. |
| SQL injection | Consultas parametrizadas com PostgreSQL; testes de injeção existentes com banco real. |
| Proxy, regras e limites | Limites por IP, e-mail e ação na aplicação; limites de autenticação persistentes. Proxy e regras da conta Cloudflare dependem do painel externo. |
| WAF | Turnstile não equivale ao WAF. É necessário colocar o domínio atrás do proxy Cloudflare e confirmar as regras no painel. Não foi declarado ativo nesta revisão. |
| Não expor backups ou senhas | Agora o HTTP serve apenas arquivos explicitamente autorizados. Bloqueia backups e código copiados por engano para `public/`, além de links simbólicos para arquivos externos. |
| Proteger o acesso direto à hospedagem | Acrescentado `ORIGIN_VERIFY_SECRET`, validado por comparação de tempo constante. Depois de configurar o proxy/regra no Cloudflare e ativar no Render, páginas, APIs e webhook exigem o header secreto da origem. GET/HEAD de `/healthz` permanece público para monitoramento. |
| Dois fatores no admin | Já implementado: TOTP, segredo cifrado AES-GCM, códigos de recuperação de uso único, rotação de sessão e confirmação administrativa por 15 minutos. Precisa da chave no servidor e cadastro do autenticador. |

## Reforços conferidos e acrescentados

- Turnstile validado no servidor por sucesso, hostname e ação; indisponibilidade não libera a operação. Respostas malformadas do provedor também bloqueiam com erro temporário.
- Cadastro pendente separado: a conta só é criada após confirmar o código do e-mail.
- Senhas com scrypt; tokens de sessão armazenados como hash; cookies HttpOnly, SameSite e Secure em produção.
- CSRF por cabeçalho próprio, Origin e Fetch Metadata; CORS não autoriza origens externas.
- CSP, bloqueio de iframe, `nosniff`, permissões restritas do navegador e HSTS em produção.
- Pedidos privados por usuário; preço calculado no banco; webhook assinado e confirmação de Pix por consulta ao provedor.
- Limites de tamanho de corpo; rejeição de JSON que não é objeto; erros sem stack, SQL ou segredos.
- Chaves e **secrets de teste** do Turnstile proibidos em produção. Exemplos corrigidos para `goatskins.com.br`.
- Documentos acessados por aliases são redirecionados em produção para a origem fixa de `APP_URL`, preservando parâmetros. O host do cliente não determina o destino; APIs e requisições POST não são redirecionadas.
- A origem pode exigir o header secreto configurado no Cloudflare, sem expô-lo em JavaScript, respostas ou logs. A opção é vazia por padrão para não impedir a configuração inicial dos provedores.
- GitHub Actions com PostgreSQL descartável e auditoria de dependências, sem credenciais de produção e com permissão de leitura. `npm run test:ci` exige banco local `goatskins_test`, evitando sucesso com testes da API ignorados.

## Loading

Logo original, dourado e azul, animação breve e saída suave após carregar os dados. Passagem mínima de 280 ms sem porcentagem fictícia; respeita movimento reduzido. Falha ou demora excessiva oferece “Tentar novamente”. Sem JavaScript, o loading não bloqueia a página. O layout após carregar é preservado. A consulta opcional de Pix pendente não segura o loading depois que a página está pronta. `PREVIA_LOADING.html` mostra a mesma interface localmente, sem banco ou servidor.

Ele aparece quando o HTML começa a carregar. Não substitui um erro do Render/Cloudflare ocorrido antes de entregar o HTML.

## Nova tela da roleta

Tela dedicada ocupando a janela, com o logo original, azul e dourado. Os bilhetes passam em uma faixa com números grandes e marcador central, mantendo a leitura mesmo em sorteios com 100 números. A faixa desacelera e para exatamente no número devolvido pelo servidor; o nome abreviado do ganhador aparece em destaque ao terminar. Há uma lista expansível de todos os números participantes, destaque do vencedor, acesso à prova e retorno ao Histórico. Movimento reduzido e sorteios com um único número apresentam o resultado sem a animação longa.

O algoritmo, as permissões, o MFA e a gravação do vencedor continuam no servidor. Cliques repetidos são bloqueados durante a operação. Uma falha de conexão oferece consulta ao resultado salvo, sem repetir automaticamente o POST de sorteio. Reabrir um resultado pelo Histórico não inicia outro sorteio. Nome e prêmio são inseridos como texto, sem interpretar HTML. `public/roulette.js` e `public/roulette.css` foram incluídos na lista explícita de arquivos públicos; nenhuma pasta adicional foi exposta.

`PREVIA_ROLETA.html` usa o mesmo componente com dados fictícios, sem API ou gravação, para conferir a apresentação localmente antes de publicar.

## Publicação observada

Em 12/10/2026, `https://goatskins.onrender.com/api/seguranca` retornou **404** e a CSP do HTML ainda não incluía `challenges.cloudflare.com`. Isso indica que o Turnstile do último commit não estava nessa versão servida. O teste do domínio personalizado não foi conclusivo neste ambiente; não foi considerado prova de DNS inválido.

As mudanças ficam nos arquivos entregues. Não houve alteração na `main` remota nem deploy no Render nesta revisão. A publicação e a configuração externa serão feitas pelo usuário, conforme solicitado.

## Pendências externas

1. **Render:** conferir o deploy de `089b9ea` e suas variáveis. `EMAIL_DRIVER=resend`, `EMAIL_API_KEY` e remetente `EMAIL_FROM` no domínio verificado; `EMAIL_CODE_SECRET` com pelo menos 32 bytes aleatórios em hexadecimal; `MFA_ENCRYPTION_KEY` com 32 bytes aleatórios em hexadecimal. Não colocar valores secretos no GitHub ou chat.
2. **Domínio:** o correto é `goatskins.com.br`, comprado no Registro.br. Confirmar domínio, certificado e registros indicados no Render. Para usar o WAF da sua conta Cloudflare, os registros web devem passar pelo proxy Cloudflare; o widget Turnstile sozinho não faz isso.
3. **Turnstile:** widget Managed autorizado para `goatskins.com.br` e aliases realmente utilizados. `APP_URL` precisa ser a origem canônica HTTPS. Na transição, configurar apenas aliases controlados em `TURNSTILE_HOSTNAMES` e no widget. Login e alterações de conta devem usar a origem canônica, pois a proteção CSRF verifica `APP_URL`.
4. **WAF e IP:** confirmar o Cloudflare Free Managed Ruleset e regras apropriadas ao plano. Não colocar desafio interativo no webhook `/api/webhooks/mercadopago`; ele se autentica por assinatura. Conferir o número real de proxies em `TRUST_PROXY_HOPS`.
5. **Origem:** o código do bloqueio está pronto; ativar `ORIGIN_VERIFY_SECRET` somente depois de configurar a Request Header Transform Rule no Cloudflare e atualizar o webhook para o domínio principal. O monitor `/healthz` continua público. Essa validação na aplicação reduz o desvio do WAF, sem substituir isolamento de rede ou impedir toda sobrecarga.
6. **Administrador e dados:** configurar o autenticador, guardar os códigos de recuperação e conferir backups/restauração. A privacidade ainda possui o contato do responsável a preencher; não foi inventado endereço de suporte.
7. **Após publicar:** conferir `/healthz`, `/api/seguranca`, cadastro com entrega real de e-mail, desafios Turnstile, MFA e Pix real. Os testes de pagamento utilizam provedor simulado, não comprovam credenciais ou entrega em produção.

## Fontes técnicas

- [Cloudflare: validação Turnstile](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Cloudflare: Turnstile independente de proxy/CDN](https://developers.cloudflare.com/turnstile/get-started/)
- [Cloudflare: WAF após proxy DNS](https://developers.cloudflare.com/learning-paths/prevent-ddos-attacks/baseline/enable-waf/)
- [Cloudflare: header secreto para proteção da origem](https://developers.cloudflare.com/learning-paths/prevent-ddos-attacks/advanced/prevent-external-connections/)
- [Cloudflare: regra para modificar headers de requisição](https://developers.cloudflare.com/rules/transform/request-header-modification/create-dashboard/)
- [GitHub: testes com PostgreSQL](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
- [ANPD: orientações sobre cookies](https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-emite-recomendacoes-para-adequacao-da-pratica-de-coleta-de-cookies-do-portal-gov.br)

## Validação

`npm ci --ignore-scripts` concluiu; `npm audit --omit=dev --json` retornou zero vulnerabilidades conhecidas. Após todas as alterações, `npm test` teve **73 aprovados, zero falhas e 62 ignorados**. Os ignorados exigem PostgreSQL real; sua instalação foi bloqueada pelas permissões deste ambiente. Isso não foi tratado como validação da API. Testes novos exercitam a origem protegida e o redirecionamento real por HTTP.

Verificações adicionais de DOM com o código real da interface: resposta instantânea com passagem breve, resposta lenta, falha 503 com botão que tenta recarregar, movimento reduzido, ausência do script principal, JavaScript desativado, texto malicioso vindo da API e Pix pendente que demora enquanto a página já está pronta. Todos os cenários passaram.

A roleta passou em **11 cenários de DOM**: 100 números e abertura sem sortear; clique repetido e revelação ao fim; resultado existente e texto malicioso; movimento reduzido; participante único; falha de rede com consulta ao vencedor; consulta sem resultado seguida de novo clique explícito; resposta inválida; redimensionamento durante a animação; navegação para prova/histórico; fluxo completo com confirmação MFA e reabertura do vencedor. Esses testes usam medidas simuladas e não equivalem a revisão visual no PC/celular. A inspeção visual em navegador não foi concluída: o navegador remoto bloqueou a abertura do arquivo local por política de URL. As duas prévias foram incluídas para conferência local no computador.

Na etapa anterior, o GitHub recusou a escrita com erro 403. Nesta etapa, conforme solicitado, a entrega é somente por arquivos, sem novas tentativas de envio. O ZIP contém o projeto completo, os arquivos novos, as prévias e `PUBLICAR_EM_CASA.md`. O workflow e o Dependabot ficam preparados para ativação quando os arquivos forem publicados. Os 62 testes com PostgreSQL, a configuração de WAF e os testes reais dos provedores continuam para execução em casa.
