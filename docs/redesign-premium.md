# GOATSKINS — redesign premium

Registro da primeira etapa. A versão atual restaura a sidebar e refina banner, cards e preços conforme [Refinamento visual](refinamento-visual.md).

Implementação local de 4 de novembro de 2026. Nenhum deploy foi realizado.

## Resultado

A identidade azul e dourada da GOATSKINS passa a ter superfícies próximas do preto, tipografia Barlow/Barlow Condensed hospedada no próprio site, navegação horizontal e um banner composto com os assets existentes da marca. A versão móvel tem composição própria, menu lateral acessível e controles de toque adequados.

Os cards têm iluminação individual em seis variantes decorativas, imagem com `object-fit: contain`, valor do prêmio, preço por número em destaque, disponibilidade, progresso real e ação de participação. As cores decorativas não significam raridade ou status. Busca sem distinção de acentos e ordenação por menor preço, maior prêmio, preenchimento e ID mais recente usam exclusivamente os dados retornados pela API.

O destaque do banner aponta para uma campanha ativa com foto, escolhida pelo maior valor informado. Ele desaparece quando não há campanha elegível; não existe conteúdo comercial fictício como fallback. Título, subtítulo, banner e cores configurados pelo administrador continuam disponíveis.

A jornada de detalhes, números, reserva, Pix, login, cadastro, recuperação, verificação, conta, histórico, administração, modais e páginas legais compartilha as mesmas superfícies e controles. O resumo da seleção fica no fluxo após a grade para não cobrir números ou informações. A barra persistente de Pix mantém seus offsets de cookies e sua lógica anterior.

## Arquivos e componentes

| Arquivo | Mudança desta implementação |
| --- | --- |
| `public/index.html` | Header, banner, destaque real, filtros, contador, estados vazios, instruções e rodapé. |
| `public/premium.css` | Tokens, fontes, navegação, hero, seis tons de cards, preço, progresso, filtros, skeleton, foco e breakpoints. |
| `public/journey.css` | Detalhe, seleção, checkout, conta/autenticação/MFA, Pix, listas, admin e leitura das páginas legais. |
| `public/style.css` | Mantida a base dos componentes existentes; retirados 1.894 bytes de seletores obsoletos dos elementos removidos. |
| `public/script.js` | Apresentação dos cards, busca/ordem, destaque, acessibilidade de números/progresso, fallback de imagem, skeleton e adaptação do menu/foco ao novo header. |
| `public/termos.html`, `privacidade.html`, `cookies.html` | Inclusão das duas camadas visuais compartilhadas, sem reescrever os documentos. |
| `public/logo-nav.webp`, `logo-loader.webp`, `mascote-hero.webp` | Derivados otimizados dos assets originais, com transparência. |
| `public/fonts/` | Quatro WOFF2 locais, licenças SIL OFL e origem documentada em `README.txt`. |
| `server.js` | Permissão explícita dos nove novos recursos públicos e MIME `font/woff2`. A allowlist continua fechada. |
| `scripts/verificar-redesign-ui.js` | QA por Chromium/CDP com fixtures locais, capturas e verificação HTTP do servidor real com banco falso. |
| `scripts/verificar-celular-ui.js`, `verificar-cookies-ui.js` | Seletores e navegação dos verificadores opcionais adaptados ao novo header. |

`premium.css` é carregado depois dos estilos existentes; `journey.css` vem em seguida. Isso preserva os componentes de roleta, viewer e biblioteca, sem migração de framework. Nenhuma dependência de produção foi adicionada.

### Padrões reutilizáveis

- Tokens de marca: `--gold`, `--copper`, `--site-bg`, `--navy`, preservados da configuração do servidor.
- Tokens de interface: `--surface`, `--surface-raised`, `--surface-soft`, `--text`, `--muted`, `--line`, `--radius`, `--radius-sm`, `--space`, `--space-section`, `--duration`, `--shadow`, `--focus`, `--font-body` e `--font-display`.
- Cards: `data-tone="gold|blue|purple|green|red|brand"`; apenas decoração, escolhida de forma estável pelo ID.
- Componentes: `.btn`, `.card`, `.price`, `.bar`, `.empty-state`, `.skeleton`, `.campaign-toolbar`, `.sale-spec`, `.sale-checkout`, `.dialog` e os componentes existentes de conta/Pix.
- Breakpoints documentados no CSS: 520px para composição compacta, 820px para navegação móvel, 1050/1100px para ajustes intermediários.

## Responsividade e acessibilidade

Foram verificadas as larguras de 360, 390, 430, 768, 1024, 1440 e 1920px, sem rolagem horizontal indevida nas jornadas testadas. A grade usa colunas automáticas com largura mínima de 245px e uma coluna em telas compactas.

O menu móvel controla `aria-expanded`, `inert`, Escape e circulação de foco. O modal isola também o novo header e recalcula o estado de fundo após mudança de largura. Busca e ordenação têm nomes acessíveis, os números anunciam seu estado e a seleção, o resumo usa feedback ao vivo e as barras de progresso expõem valores reais. Há link para pular ao conteúdo, foco visível e respeito a `prefers-reduced-motion`.

O header autenticado quebra em duas linhas quando necessário no intervalo intermediário; nomes longos têm truncamento visual e texto completo disponível no botão. A imagem da skin permanece inteira, com dimensões definidas, carregamento tardio e fallback quando falha. O skeleton existe somente enquanto uma imagem está carregando.

## Performance

| Recurso original | Derivado utilizado | Tamanho |
| --- | --- | --- |
| `logo-marca.webp`: 290.148 bytes | `logo-nav.webp`, 96 × 102 | 5.716 bytes |
| `logo-marca.webp`: 290.148 bytes | `logo-loader.webp`, 168 × 178 | 11.634 bytes |
| `mascote.webp`: 117.222 bytes | `mascote-hero.webp`, 600 × 820 | 80.922 bytes |
| Favicon `logo.jpg`: 438.258 bytes | Reutilização de `logo-nav.webp` | 5.716 bytes |

As fontes locais somam 89.876 bytes e usam `font-display: swap`; a fonte principal do título é pré-carregada. Não existem requisições a Google Fonts em runtime. Hover e skeleton usam transform/opacity e as animações são desativadas quando o usuário prefere menos movimento. Os indicadores LCP, CLS e INP não receberam uma medição de produção; estas são melhorias de implementação, não uma pontuação de laboratório.

## Validação

- Suíte atual, com lista explícita de `tests/*.test.js`: **301 testes; 129 aprovados, 0 falhas, 172 ignorados**. Log em `validation/premium-redesign/tests.log`.
- QA final no Chromium: **44 verificações aprovadas, 0 falhas**. Evidência em `validation/premium-redesign/after-qa.json`.
- Foram exercitados busca, ordenação, menu, nome longo, header autenticado/admin, seleção e limite de números, reservas, payload da reserva, Pix simulado, login/cadastro/recuperação, foco após resize, estados vazio/erro, falha de imagem e redução de movimento.
- HTTP com o servidor real e banco falso: os nove assets novos retornaram 200, MIME correto e bytes idênticos; arquivos privados e caminhos fora da allowlist continuaram bloqueados. Evidência em `validation/premium-redesign/http-assets.json`.
- Após a última mudança no carregamento de imagens, as suítes de navegador de Pix, viewer e predefinições foram executadas novamente: **11 aprovados, 0 falhas, 0 ignorados**. Log em `validation/premium-redesign/tests-browser-final.log`; esses casos fazem parte da suíte atual, não são somados à contagem anterior.
- Nenhuma exceção JavaScript ou requisição externa no QA. As fixtures não acessaram contas, pagamentos ou banco de produção.
- A execução inicial de `npm test` também encontrou cópias históricas em `validation/deploy-*`: 874 testes, 380 aprovados, 0 falhas e 494 ignorados. A contagem de 301 acima corresponde somente à suíte atual.

O banco PostgreSQL de teste não estava configurado (`TEST_DATABASE_URL` ausente). Os 172 testes ignorados **não foram considerados aprovados**. Autenticação, pagamentos, Turnstile, recuperação, sorteio e integrações reais não foram exercitados contra serviços de produção. Seus endpoints, regras, modelos, segredos e mecanismos de segurança não foram alterados para o redesign.

### Problemas encontrados e resolvidos

1. A orientação vertical herdada fazia o header desktop ocupar cerca de 273px: definida orientação horizontal explícita e validada sua altura.
2. Header autenticado e nome de 80 caracteres transbordavam em larguras intermediárias: adicionada quebra de linha e contenção do texto.
3. O checkout sticky podia cobrir o título da seleção: resumo e CTA passaram a ficar no fluxo após a grade.
4. Um modal aberto no mobile podia manter o conteúdo inerte depois de voltar ao desktop: o estado é recalculado ao fechar.
5. O rótulo da ordenação desaparecia da árvore de acessibilidade no mobile: adicionado nome acessível explícito.
6. Os novos recursos eram bloqueados pela allowlist estática original: adicionados somente seus caminhos exatos e o tipo de fonte.

## Capturas

As campanhas, nomes de participantes e valores presentes nas capturas são **fixtures exclusivamente de teste**. As fotos são imagens oficiais da Steam usadas somente no QA local; suas origens estão em `validation/premium-redesign/fixtures/sources.json`. Nenhuma dessas campanhas foi incluída no site público.

| Tela | Antes | Depois |
| --- | --- | --- |
| Home desktop | [1440px](../validation/premium-redesign/before-home-1440.png) | [1440px](../validation/premium-redesign/after-home-1440.png) |
| Home mobile | [390px](../validation/premium-redesign/before-home-390.png) | [390px](../validation/premium-redesign/after-home-390.png) |
| Cards | — | [1920px](../validation/premium-redesign/after-grid-1920.png) |
| Detalhe | — | [390px](../validation/premium-redesign/after-detail-390.png) |
| Seleção e resumo | — | [390px](../validation/premium-redesign/after-numbers-390.png) |
| Login | — | [390px](../validation/premium-redesign/after-auth-entrar-390.png) |
| Cadastro | — | [1440px](../validation/premium-redesign/after-auth-criar-1440.png) |
| Pix | — | [390px](../validation/premium-redesign/after-pix-390.png) |

As evidências ficam em `validation/`, que já é ignorado pelo Git; estão disponíveis neste workspace.

## Reproduzir e pendências

```powershell
node scripts/verificar-redesign-ui.js --after
node scripts/verificar-redesign-ui.js --http-only
```

Os comandos usam Chrome/Edge já instalado e dispensam Playwright, `.env`, PostgreSQL e provedores externos. O script pode receber `SECURITY_AUDIT_BROWSER` conforme o helper existente. A comparação anterior usa o snapshot local de três arquivos em `validation/premium-redesign/before/`.

Para rodar os casos PostgreSQL ignorados, configure uma instância local descartável chamada `goatskins_test` e execute `npm run test:ci` conforme `docs/testes.md`.

Há uma pendência de conteúdo anterior a este trabalho: a seção Contato de `public/privacidade.html` ainda pede o e-mail do responsável. Esse endereço precisa ser fornecido pelo proprietário; não foi inventado.

Os verificadores opcionais antigos continuam dependendo de Playwright, que não está instalado neste projeto. A nova verificação CDP foi executada no ambiente disponível. A validação de integrações externas e eventual deploy ficam para uma etapa autorizada pelo proprietário.
