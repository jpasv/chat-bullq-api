# Agente de onboarding pós-venda: registro de ajustes

Histórico de cada ajuste pedido no agente que aborda os compradores da list *Leads onboarding* do Hoppe pelo WhatsApp 1258. Cada linha registra a data, quem pediu, o que foi pedido, o que mudou e onde a mudança ficou.

Desenho completo: `docs/superpowers/specs/2026-10-18-lead-onboarding-ia-design.md`.

Como registrar um ajuste novo: acrescentar uma linha no fim da tabela, com a data, quem pediu, o pedido nas palavras da pessoa (resumido) e o PR ou commit que aplicou.

| # | Data | Quem pediu | Pedido | O que mudou | Onde |
|---|---|---|---|---|---|
| 1 | 18/10/2026 | Tiago Teles | Agente para atender comprador low ticket, qualificar e agendar reunião de venda | Desenho do fluxo: abordagem, qualificação e agendamento | spec |
| 2 | 18/10/2026 | Tiago Teles | Atualizar o pipeline do Hoppe (Comercial > Onboarding Members > Leads onboarding), não o do chat-bullq | O Hoppe é a fonte de verdade: status, campos, tags e comentários vão para a task | PR #20 |
| 3 | 18/10/2026 | Tiago Teles | 1ª mensagem quando chega o lead; 2ª depois de 4h; 3ª depois de 24h; sem resposta, inativar | Cadência 0h, +4h, +24h e inativação 24h depois da 3ª tentativa | PR #20 |
| 4 | 18/10/2026 | Tiago Teles | Só mover para "em qualificação" se o lead responder | O status muda apenas com resposta do lead | PR #20 |
| 5 | 18/10/2026 | Tiago Teles | Tag em cada tentativa e comentário-resumo de cada comunicação | Tags `1º/2º/3º mensagem`, um comentário por evento e um resumo da conversa 30 min depois da última mensagem | PR #20, #22 |
| 6 | 18/10/2026 | Tiago Teles | Qualificação: objetivo com Claude Code, nível, faturamento, se é decisor e quem são os sócios, prioridade | Esses critérios entram no prompt e na tool `registrarQualificacao` | PR #20 |
| 7 | 18/10/2026 | Tiago Teles | Todos os sócios presentes na reunião | Só agenda com todos os sócios confirmados; antes disso fica em "aguardando sócios", com uma retomada após 24h | PR #20 |
| 8 | 18/10/2026 | Tiago Teles | Rio e mais de R$ 500k/ano: evento presencial. Fora do Rio e mais de R$ 500k/ano: Maestria | A oferta sugerida aparece no comentário do Hoppe para o Pedro | PR #20 |
| 9 | 18/10/2026 | Tiago Teles | Reunião na agenda do Pedro, em agenda nova, das 9h às 20h, de segunda a segunda | Agenda "Diagnósticos de IA – Pedro" criada na conta produtos@asv.digital | PR #20 |
| 10 | 18/10/2026 | Tiago Teles | Gatilho por tag, adicionada na entrada do lead ou manualmente | Tag `abordar-ia` → automação do Hoppe → webhook do chat-bullq | PR #20, #21 |
| 11 | 18/10/2026 | Tiago Teles | Custom field "Atividade" com as opções Ativo (respondendo ou inicial) e Inativo (não responde) | Campo criado na list e preenchido pelo fluxo | PR #20 |
| 12 | 18/10/2026 | Tiago Teles | Disparar pelo número 1258 | Canal Zappfy "Tiago 1258". O agente não fica vinculado ao canal, então só responde conversas abertas pelo fluxo | PR #20 |
| 13 | 18/10/2026 | Tiago Teles | Qualificado = fatura mais de R$ 500k, é decisor e tem prioridade média ou alta | Regra inicial, substituída pelo item 14 | spec |
| 14 | 18/10/2026 | Tiago Teles | A partir de R$ 50k (mensal) já pode agendar | Corte de qualificação em R$ 50 mil/mês; os R$ 500k/ano só definem a oferta | PR #20 |
| 15 | 18/10/2026 | Tiago Teles | Postura de consultor pós-venda, não 100% venda, porque a pessoa já comprou | Tom do prompt e da copy: ajudar primeiro, qualificar depois | PR #20 |
| 16 | 18/10/2026 | Tiago Teles | Script bem específico, passado pelo humanizer | Copy das mensagens escrita e revisada | spec |
| 17 | 18/10/2026 | Tiago Teles | Confirmar o faturamento que veio do formulário ("você marcou que fatura X, é isso mesmo?") | Pergunta de confirmação no prompt | PR #20 |
| 18 | 18/10/2026 | Tiago Teles | Revisão da copy: diagnóstico gratuito, limites da oferta, objeções | Seção "Script de mensagens" reescrita | spec |
| 19 | 18/10/2026 | Tiago Teles | Silêncio não desqualifica | Sem resposta: Atividade = Inativo e o status continua "nova oportunidade" | PR #20 |
| 20 | 18/10/2026 | Tiago Teles | Faturamento não confirmado: a IA pergunta | Pergunta uma vez. Sem resposta, fica em "em qualificação" sem convite | PR #20 |
| 21 | 18/10/2026 | Tiago Teles | Diagnóstico de 1h | Blocos de 60 min na agenda e na copy | PR #20 |
| 22 | 18/10/2026 | Tiago Teles | Manter 3 tentativas | Cadência de 3 mantida | PR #20 |
| 23 | 18/10/2026 | Tiago Teles | Rio = DDD 21 | `isRio` olha o DDD do WhatsApp | PR #20 |
| 24 | 18/10/2026 | Tiago Teles | Persona com nome Tiago, porque roda no WhatsApp dele | Abertura inicial "assistente virtual do Tiago", substituída no item 28 | PR #20 |
| 25 | 18/10/2026 | Tiago Teles | O Pedro usa o e-mail produtos@asv.digital | `ONBOARDING_CLOSER_EMAIL=produtos@asv.digital` | env |
| 26 | 18/10/2026 | Tiago Teles | Começar só com a fase A; base de conhecimento do members (completa) depois | O agente não orienta uso do produto e transfere para humano. Subprojeto B adiado | spec |
| 27 | 18/10/2026 | Tiago Teles | Separar o chat do Nairio do chat da Bravy | Todo o trabalho feito no repo jpasv/chat-bullq-api (VPS da Bravy) | — |
| 28 | 18/10/2026 | Tiago Teles | Não se apresentar como assistente virtual do Tiago; "aqui é da Bravy" | Abertura "Aqui é da Bravy". Se perguntarem direto, a IA diz que é atendimento automático | PR #23 |
| 29 | 18/10/2026 | Tiago Teles | Aplicar o humanizer e não colocar ponto final, para não parecer IA | Regras de estilo no prompt e remoção automática do ponto final nas tentativas e nas respostas | PR #24 |
| 30 | 18/10/2026 | Tiago Teles | Não deixar o lead esfriar: quando responder, já perguntar o objetivo principal e a maior dor | Condução ativa no prompt; sem "pode olhar com calma" | PR #24 |
| 31 | 18/10/2026 | Tiago Teles | Objetivo sobre Claude Code, não só o produto comprado | Pergunta "qual o principal objetivo que você quer alcançar com o Claude Code?" | PR #25 |
| 32 | 18/10/2026 | Tiago Teles | A IA responde rápido demais: esperar 30 a 45 segundos | Atraso aleatório de 30 a 45s nas conversas do onboarding | PR #26 |
| 33 | 18/10/2026 | Tiago Teles | O lead mandou várias mensagens seguidas e a IA respondeu cada uma separada | O mesmo atraso do item 32 reinicia a cada mensagem nova, e a IA responde ao bloco inteiro | PR #26 |
| 34 | 18/10/2026 | Tiago Teles | Documentar cada ajuste com data e quem pediu | Este arquivo | este PR |

## Correções técnicas (sem pedido explícito)

Problemas encontrados na revisão ou em produção e corrigidos durante a implantação.

| Data | Encontrado por | Problema | Correção | Onde |
|---|---|---|---|---|
| 18/10/2026 | Revisão de código | A guarda contra pegar conversa existente do Tiago nunca disparava (filtro JSON do Prisma) | Consulta em SQL direto | PR #20 |
| 18/10/2026 | Revisão de código | Risco de mensagem em dobro e de tentativa para quem já respondeu | Claim atômico e checagem da conversa antes de cada tentativa | PR #20 |
| 18/10/2026 | Teste em produção | A condição de tag da automação do Hoppe nunca dispara | Automação sem condição; o webhook filtra pela tag `abordar-ia` | PR #21 |
| 18/10/2026 | Teste em produção | O Hoppe dá erro 500 ao adicionar tag com corpo vazio | Envio com corpo `{}` | PR #22 |
| 18/10/2026 | Teste em produção | O número do WhatsApp pode ter JID sem o 9º dígito | O JID real é resolvido no Zappfy (`/chat/check`) | PR #20 |
