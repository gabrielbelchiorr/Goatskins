# Visualização 3D e predefinições de sorteios

O visualizador do GOATSKINS utiliza a Embed API oficial do **CS2Inspect**. Para configurar a chave, autorizar domínios, revisar modelos antigos e executar os testes ao vivo, consulte [CS2Inspect](cs2inspect.md).

## Configuração da skin

Em **Admin → Sorteios**, crie ou edite uma campanha. Na seção **Visualização 3D da skin**, ative o recurso, identifique a skin pelo nome ou identificador oficial e revise os atributos. Use **Prévia 3D** antes de salvar. A prévia não publica nem modifica a campanha.

O botão **Visualizar em 3D** aparece nos cards e detalhes quando existe configuração válida. A imagem original é preservada. Ao fechar por botão, Escape ou clique no fundo, o iframe é removido.

Configurações antigas que não possam ser convertidas com segurança exibem um aviso administrativo. Seus demais dados permanecem disponíveis. A troca de provedor não modifica o prêmio real nem seus atributos anunciados.

## Biblioteca de predefinições

Em **Admin → Predefinições de Sorteios**, use **Criar predefinição**, preencha os campos e salve. É possível pesquisar, consultar detalhes, editar, duplicar e excluir com confirmação.

Em um novo sorteio, **Utilizar predefinição → Selecionar** copia os campos para revisão. Não publica automaticamente. Use **Prévia do sorteio**, ajuste o necessário e confirme em **Adicionar sorteio**.

Os formulários de criação e edição também oferecem **Salvar como predefinição**. Quando há um modelo de origem, **Salvar alterações na predefinição original** exige confirmação, enquanto **Salvar como nova predefinição** cria outra entrada. Criar a campanha não altera o modelo. Conflitos de versão impedem sobrescrever a edição de outro administrador; recarregue a biblioteca antes de tentar novamente.

O snapshot contém somente configurações reutilizáveis: prêmio, desgaste, descrição, valor de exibição, preço por número, quantidade e limite por pessoa, cor, imagem e parâmetros 3D. Não copia participantes, reservas, pagamentos, resultados ou sementes. As configurações ficam no PostgreSQL, sem dependência do disco do Render ou de localStorage.

Cada campanha continua recebendo seu próprio identificador, semente, compromisso, participantes, pagamentos e resultado. Editar ou excluir uma predefinição não modifica campanhas criadas com ela. As rotas permanecem protegidas pelos mecanismos administrativos de sessão, autorização, MFA, CSRF e auditoria existentes.
