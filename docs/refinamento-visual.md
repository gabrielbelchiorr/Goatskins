# GOATSKINS — refinamento visual e sidebar

Segunda etapa implementada localmente em 4 de novembro de 2026. Substitui a direção visual da primeira etapa descrita em `redesign-premium.md`. Nenhum deploy foi realizado.

## Mudanças

- Sidebar vertical fixa à esquerda no desktop, com logo original, acesso à conta, navegação e administração separados. O botão no topo recolhe a sidebar e devolve sua largura ao conteúdo. A preferência desktop continua condicionada ao consentimento de cookies.
- No celular, a sidebar funciona como menu recolhível, com Escape, navegação por teclado, retorno de foco e fundo inerte. Header e sidebar também são isolados ao abrir modais.
- O banner foi refeito com cerca de **251px no desktop** e **240px em 390px**, sem a ilustração militar do mascote. A imagem pertence a uma campanha ativa real retornada pela API. Sem foto elegível, resta uma composição tipográfica discreta, sem simular uma skin ou campanha.
- A busca foi removida completamente da homepage, incluindo listeners e estados de busca vazia. A pesquisa da biblioteca administrativa permanece intacta. Título, contagem real, ordenação e grid formam uma única seção compacta.
- `--price-gold: var(--gold)` centraliza a cor dos valores. Prêmio, número, destaque, resumo, Pix, histórico, pedidos e valores administrativos usam a mesma identidade dourada; as cores de erro e de situação do pagamento continuam semânticas.
- Cards com imagem inteira, tipografia legível, proporções mais compactas e iluminação suave. As cores secundárias ficam nas bordas e no progresso, sem colorir preços. Textos auxiliares deixaram de usar caixa alta em excesso.
- Ações administrativas ficam em **Gerenciar sorteio**, recolhidas por padrão e criadas somente quando o usuário tem o papel administrativo existente. Os callbacks de editar, encerrar e abrir roleta mantêm as regras anteriores. Abrir esses controles não estica o conteúdo público dos demais cards.
- A seção de instruções perdeu os grandes blocos decorativos. Os títulos e formulários complementares receberam uma tipografia mais natural.

Em **1920 × 1080**, a grade começa aproximadamente no pixel **437** e a primeira fileira de seis cards públicos, incluindo seus botões, aparece inteira na captura. Em 1440px são quatro colunas; em 768px, duas; em 390px, uma. A largura da sidebar desktop é 236px.

## Arquivos desta etapa

| Arquivo | Alteração |
| --- | --- |
| `public/index.html` | Sidebar independente, topo compacto, novo banner, remoção da busca e reorganização da seção ativa. |
| `public/premium.css` | Direção visual refinada, layout da sidebar, grid, cards e token monetário. A camada caiu de 28.068 para cerca de 23.900 bytes. |
| `public/journey.css` | Tipografia mais contida e preços padronizados nas interfaces complementares. |
| `public/script.js` | Apresentação, ordenação, remoção da pesquisa da home, destaque real, menu/foco e disclosure administrativo. Valores monetários receberam marcação de apresentação. |
| `public/termos.html`, `privacidade.html`, `cookies.html` | Atualização da versão dos estilos compartilhados; textos legais preservados. |
| `scripts/verificar-redesign-ui.js` | Validações adaptadas à sidebar, ausência de pesquisa, preços uniformes e ações administrativas. |
| `scripts/verificar-celular-ui.js`, `verificar-cookies-ui.js` | Seletores dos verificadores opcionais ajustados para a sidebar e seu recolhimento desktop. |
| `tests/fixtures/skins/` | Imagens oficiais para reproduzir o QA sem depender de artefatos ignorados em `validation/`. Uso exclusivo de testes, fora de `public/`. |

Não houve alteração nesta etapa em `server.js`, endpoints, banco, modelos, segurança, autenticação, reservas, pagamentos, webhooks, determinação de vencedor ou integração 3D. A configuração existente de título, subtítulo, banner e paleta permanece disponível.

## Validação

- **48 verificações de navegador aprovadas, nenhuma falha.** Chrome real via CDP, sete larguras: 360, 390, 430, 768, 1024, 1440 e 1920px.
- Conferidos sidebar fixa, recolhimento desktop, menu móvel, teclado, foco após resize, ausência de busca e espaço reservado, ordenação, cor dos valores, isolamento de administração, nomes longos, seleção/limite/reservas, Pix simulado, formulários, páginas legais, carregamento e falha de imagem, movimento reduzido e estados vazio/erro.
- **Suíte atual: 301 testes, 129 aprovados, nenhuma falha e 172 ignorados.** A execução usou os arquivos atuais de `tests/*.test.js`, com bloqueio de `.env` e de rede externa nos processos Node. Os casos PostgreSQL não rodaram sem `TEST_DATABASE_URL` descartável.
- **HTTP do servidor real com banco falso:** nove recursos retornaram 200 com MIME e bytes corretos; três caminhos não autorizados permaneceram bloqueados. Nenhuma exceção JavaScript ou requisição externa no QA.
- Verificação de sintaxe JavaScript e `git diff --check` sem erros.

Os dados comerciais das capturas são **fixtures locais de teste**, com imagens oficiais da Steam cuja origem está em `tests/fixtures/skins/sources.json`. O site continua renderizando exclusivamente as campanhas recebidas do backend. Não foram inseridas campanhas fictícias no aplicativo, e os provedores/banco operacionais não foram acessados para a validação.

## Capturas

| Tela | Antes | Depois |
| --- | --- | --- |
| Desktop 1920px | [Antes](../validation/visual-refinement/before-home-1920.png) | [Depois](../validation/visual-refinement/after-home-1920.png) |
| Desktop 1440px | [Antes](../validation/visual-refinement/before-home-1440.png) | [Depois](../validation/visual-refinement/after-home-1440.png) |
| Celular 390px | [Antes](../validation/visual-refinement/before-home-390.png) | [Depois](../validation/visual-refinement/after-home-390.png) |
| Menu móvel | — | [Captura](../validation/visual-refinement/after-menu-390.png) |
| Ações administrativas | — | [Captura](../validation/visual-refinement/after-admin-card-1440.png) |
| Detalhe móvel | — | [Captura](../validation/visual-refinement/after-detail-390.png) |
| Seleção e resumo | — | [Captura](../validation/visual-refinement/after-numbers-390.png) |

Evidências e snapshot da primeira etapa ficam em `validation/visual-refinement/`, diretório já ignorado pelo Git. `after-qa.json` inclui as medidas da composição por largura; `tests.log` registra a suíte; `http-assets.json` registra a entrega de recursos.

## Reproduzir

```powershell
node scripts/verificar-redesign-ui.js --after
node scripts/verificar-redesign-ui.js --http-only
```

Esses comandos usam Chrome/Edge local e dispensam Playwright e banco. Os verificadores antigos de celular/cookies tiveram sintaxe validada, mas não foram executados porque exigem Playwright, ausente neste projeto. A validação visual executada nesta etapa foi feita pelo verificador CDP.

Permanecem as pendências anteriores: configurar PostgreSQL descartável para os casos de integração ignorados e informar o e-mail do responsável na seção Contato da política de privacidade. Nenhum endereço foi inventado. A etapa não publicou o site nem acionou integrações externas.
