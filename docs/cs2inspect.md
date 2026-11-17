# CS2Inspect no GOATSKINS

## Configuração manual

A chave pública **goatskins local**, autorizada para `localhost`, já foi inserida somente no `.env` local como `CS2INSPECT_EMBED_KEY` e validada com o serviço real. Não está nos arquivos versionados. Reinicie a aplicação local para carregar a variável e abra o site usando `localhost`.

No Render, antes de iniciar a versão com esta integração, configure em **Environment** a chave **goatskins**, autorizada para `goatskins.com.br`:

```text
CS2INSPECT_EMBED_KEY=sua_chave_publica_de_embed
```

Não são necessárias novas dependências, chaves privadas ou alterações nas credenciais de banco, autenticação ou pagamentos. A chave de embed é pública e aparece nas requisições do iframe; a restrição de acesso é feita pelos sites autorizados no provedor.

Em **CS2Inspect → conta → API → sua chave**, autorize os hosts onde o GOATSKINS será aberto:

- `localhost` e `127.0.0.1` para desenvolvimento e os testes ao vivo.
- O domínio de produção, por exemplo `goatskins.com.br`.
- `www.goatskins.com.br`, se esse endereço servir a página.
- O hostname `seu-servico.onrender.com`, se o acesso direto a ele for utilizado.

Use os hosts sem protocolo, caminho ou porta. O provedor ignora portas; também permite padrões como `*.example.com`. Evite autorizar domínios que você não controla. Consulte o [procedimento oficial de criação e autorização da chave](https://cs2inspect.skin/docs/api).

Até que o host esteja autorizado, o serviço responde `origin_not_allowed`. O modal mostra a orientação correspondente; esse erro não impede o restante do site de funcionar.

Cada chave usa sua própria lista de hosts. A chave local atual autoriza `localhost`; para abrir por `127.0.0.1`, autorize esse host na mesma chave ou altere a variável para a chave específica desse endereço. A chave de produção fica nas variáveis do Render.

## Revisão dos modelos antigos

No painel administrativo, abra a campanha ou predefinição sinalizada com **Visualização 3D precisa ser configurada novamente**. Ative a visualização, escolha o nome Steam, o identificador do catálogo ou o modelo/paint index e informe os atributos do item. Confira a **Prévia 3D** e salve.

Float, padrão, StatTrak, name tag, stickers, charm e visualização inicial são reutilizados nas predefinições. Os controles sem aplicação para facas ou luvas ficam desabilitados. Os índices dos acessórios são os identificadores oficiais do catálogo. Mantenha **Representação ilustrativa** marcada quando os parâmetros não representarem necessariamente o prêmio real.

Não foi feita conversão por aproximação dos links antigos. A migração 12 somente acrescenta `campaigns.viewer_3d` (JSONB) e os marcadores opcionais `viewer_3d_pendente` em campanhas e predefinições. Os campos legados e snapshots anteriores permanecem armazenados; não são usados para gerar URLs. A revisão pendente é calculada na leitura, sem reescrever campanhas ativas. Duplicar ou aplicar um modelo antigo preserva o aviso e seus demais dados. Configurar um modelo novo ou remover explicitamente a visualização resolve o aviso.

As migrações rodam pelo fluxo já existente de inicialização. Faça o backup habitual do PostgreSQL antes de publicar. Nenhum deploy foi executado por esta tarefa.

## Comportamento e segurança

A integração utiliza exclusivamente o iframe oficial `https://cs2inspect.skin/embed`, com fundo transparente, crédito minimalista do plano gratuito, destaque dourado e controles interativos. O iframe só é montado ao abrir o modal e é removido ao fechar ou trocar a visualização.

A CSP autoriza o provedor somente em `frame-src`; não é necessário liberar scripts ou conexões do domínio no documento principal. O código compartilhado valida a configuração no navegador e novamente no backend. O modal aceita mensagens somente da origem oficial, da janela do iframe ativo e com o identificador oficial de origem da mensagem. O evento de carregamento do documento não é tratado como confirmação do modelo: o modal aguarda `ready` ou apresenta o erro informado pelo provedor.

Não há Studio do provedor anterior, decoder de inspect link, SDK externo ou chamada a API privada. As regras financeiras e o gerenciamento de usuários não foram alterados.

## Testes

Os testes de API usam apenas o PostgreSQL local descartável `goatskins_test`. Os testes comuns de navegador simulam o provedor e bloqueiam a rede externa.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://USUARIO:SENHA@127.0.0.1:PORTA/goatskins_test'
npm run test:ci
node --test tests/cs2inspect.test.js tests/skin-viewer.browser.test.js tests/predefinicoes.browser.test.js
```

Para testar o iframe real depois de autorizar o ambiente local:

```powershell
node scripts/verificar-cs2inspect-live.js --case weapon
node scripts/verificar-cs2inspect-live.js --case knife
node scripts/verificar-cs2inspect-live.js --case gloves --mobile
```

O script lê somente a variável pública do ambiente ou sua linha no `.env`, mascara a chave nas URLs das evidências e falha se o provedor não preparar o modelo. Os relatórios e capturas ficam em `validation/cs2inspect-live-*`; a suíte geral registra sua saída em `validation/cs2inspect-suite.log` nesta execução.

### Resultado desta execução

- Suíte completa: **308 testes; 307 aprovados, nenhuma falha, um ignorado** pelo teste de symlink no Windows.
- Cobertura: configuração de armas, facas e luvas; atributos/acessórios; migração sem reescrever dados existentes; modelos antigos e avisos; CRUD, independência e persistência das predefinições; eventos oficiais, erros, prévia, mobile, foco e descarte do iframe. Provedores de pagamento foram simulados nos testes de regressão existentes.
- Após configurar a chave específica de `localhost`, os três testes externos foram aprovados: **AK-47 | Redline**, **Karambit | Doppler** e **Sport Gloves | Vice**, incluindo luvas no viewport móvel. O provedor confirmou `ready`; as capturas foram revisadas e mostram os modelos reais. Rotação, zoom e descarte do iframe foram verificados. AK-47 e Karambit também confirmaram `view=hands` e foram inspecionadas visualmente em primeira pessoa. Nenhum erro de rede ou JavaScript foi registrado nessas execuções.
- Verificação focada posterior: **11/11 testes automatizados aprovados**, sem falhas ou skips, cobrindo o módulo compartilhado, o modal e o painel/predefinições.
