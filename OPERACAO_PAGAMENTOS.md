# Revisão de pagamentos e reservas Pix

O painel Admin > Pedidos destaca criação incerta há pelo menos cinco minutos e pedidos pendentes há quinze minutos além do prazo de checkout. Pedidos pendentes antigos têm prioridade na lista. O alerta não cancela cobranças, confirma pagamentos nem libera números.

1. Registre a referência do pedido, Order (quando houver), horário, valor e números. Use o painel autenticado com MFA. Evite copiar dados pessoais para canais públicos.
2. Confira na conta correta do Mercado Pago a cobrança correspondente. Compare referência externa, Order, valor e situação; não use comprovante enviado pelo comprador como confirmação.
3. Se houve pagamento, a confirmação deve passar pela consulta autenticada ao provedor e pelo fluxo de reconciliação existente. Verifique se o pedido ficou PAID ou REFUND_NEEDED e se os números correspondem. Pagamento tardio com número indisponível exige reembolso.
4. Se o provedor confirmar cancelamento/expiração, a rotina existente deve atualizar o pedido e liberar a reserva. Quando a Order é conhecida, ela consulta antes de cancelar; não desfaz pagamento já confirmado.
5. Se a criação continua incerta ou o provedor está indisponível, mantenha a reserva. Verifique erros de configuração, disponibilidade e limites do provedor; acione suporte se necessário. Não marque como pago nem altere reservas diretamente no banco para resolver o alerta.
6. Ausência de uma cobrança em uma busca ou passagem do tempo, isoladamente, não comprova que ela nunca foi criada. Antes de qualquer correção excepcional, obtenha evidência conclusiva do provedor e revisão técnica; preserve a trilha de auditoria. A aplicação não oferece liberação forçada para esse caso.
7. Para REFUND_NEEDED, efetue e confirme o reembolso no provedor antes de usar “Marcar reembolsado”. Esse botão registra a operação; ele não devolve dinheiro.

Em incidentes persistentes, acompanhe os alertas do painel e os eventos PIX_CRIACAO_INCERTA, PAGAMENTO_IGNORADO e PAGAMENTO_TARDIO_REEMBOLSAR nos logs administrativos. Valide notificações e tentativas de reconciliação também na infraestrutura. A interface limita a lista a 200 pedidos; em acúmulo maior, a investigação operacional deve considerar a base completa com acesso autorizado.

As verificações de lançamento usam exclusivamente banco local descartável e provedor simulado. Homologação com Mercado Pago deve usar contas/credenciais de teste em ambiente separado, sem cobranças reais.
