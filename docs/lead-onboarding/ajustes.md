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
| 34 | 18/10/2026 | Tiago Teles | Documentar cada ajuste com data e quem pediu | Este arquivo | PR #27 |
| 35 | 18/10/2026 | Tiago Teles | Toda demanda de suporte vai para a Lívia, que resolve e devolve para o agente continuar a qualificação | Tool `encaminharSuporte` (onboarding → Lívia) e o `handBackToOrchestrator` da Lívia devolve para o agente de onboarding; atraso de 30-45s vale também na vez da Lívia | PR #28 |
| 36 | 19/10/2026 | Tiago Teles | A tag `abordar-ia` deve entrar automaticamente | Automação do Hoppe `581146c0` (task criada na Leads onboarding → adiciona `abordar-ia` e chama o webhook). Todo formulário de onboarding novo é abordado sem ação manual | Hoppe |
| 37 | 19/10/2026 | Tiago Teles | Postar no canal "Leads onboarding" do Hoppe sempre que precisar de um humano (pode usar a conta do Tiago) | Pedido de aprovação do agente (ex.: `transferToHuman`) numa conversa do onboarding vira post no canal e comentário na task, uma vez por pedido. Posta pela API interna com o login do Tiago | PR #30 |
| 38 | 19/10/2026 | Tiago Teles | Start date = última ação e due date = próxima ação em todo lead; em reunião agendada, start/due = início/fim da reunião | Toda ação do fluxo atualiza as datas da task (tentativa, resposta, inativação, qualificação, pendência, suporte, opt-out, pausa). Sem próxima ação agendada, o due fica vazio | PR #30 |
| 39 | 19/10/2026 | Tiago Teles | Lead em qualificação não pode ficar sem próxima ação | Até 2 retomadas automáticas, 24h depois do silêncio do lead, na janela 8h-20h; depois Atividade = Inativo com status mantido. Due date = próxima retomada. Não cutuca quando a conversa está com o time | PR #31 |
| 40 | 19/10/2026 | Tiago Teles | Aguardando humano também ganha tag | Tag `aguardando-humano` quando o agente pede humano, com start/due na hora do pedido (task fica atrasada até alguém agir). Sai quando alguém responde pelo WhatsApp do Tiago | PR #31 |
| 41 | 19/10/2026 | Tiago Teles | A conversa ainda está muito robotizada | Prompt reescrito: proibido repetir/parafrasear o lead, reagir antes de perguntar, perguntas variadas em palavras do dia a dia, lista de termos proibidos (principal objetivo, maior dor, operação, implantação...), exemplos de antes e depois das conversas reais, resposta de robô do lead vai pra humano. Abertura em 2 balões com nome curto do produto. Resposta da IA quebra em balões e a Lívia segue o mesmo tom (sem ponto final) nas conversas do onboarding | PR #33 |
| 42 | 19/10/2026 | Tiago Teles | Quem quiser saber da aula recebe o link do grupo dos alunos (https://grupos-api.bravy.com.br/g/alunos-agents) | Regra no prompt do agente e na nota da Lívia; domínio grupos-api.bravy.com.br liberado na lista de links da organização | PR #35 |
| 43 | 19/10/2026 | Tiago Teles | Tudo que o lead perguntar se dá pra fazer, dizer que dá, e já introduzir o diagnóstico que ele ganha | Prompt: resposta "dá sim" com IA/Claude Code e apresentação do Diagnóstico de IA logo em seguida; agendamento continua só depois do encaixe (faturamento, sócios) | PR #37 |
| 44 | 19/10/2026 | Tiago Teles | "Precisamos de agendamentos efetivos" | Prompt focado em marcar: convite cedo e já com 2 horários, qualificação confirmada no caminho. Só bloqueia faturamento informado abaixo de R$ 50k/mês; faturamento desconhecido, prioridade e nível não barram. Sócios continuam convidados. Uma oferta de horário concreto quando o lead hesita | PR #38 |
| 45 | 19/10/2026 | Tiago Teles | Confirmando muito e conduzindo pouco; ser mais agressivo e atrativo no convite | Prompt: no máximo 2 perguntas antes do convite (se o lead já disse o que quer, convida já); proibido confirmar/checar entendimento e pedir permissão; convite afirmativo com valor (gratuito, só pra cliente, 1h com o Pedro no caso dele) e 2 horários reais, perguntando qual horário e não se quer; uma contra-proposta quando hesita | PR #39 |

## Correções técnicas (sem pedido explícito)

Problemas encontrados na revisão ou em produção e corrigidos durante a implantação.

| Data | Encontrado por | Problema | Correção | Onde |
|---|---|---|---|---|
| 18/10/2026 | Revisão de código | A guarda contra pegar conversa existente do Tiago nunca disparava (filtro JSON do Prisma) | Consulta em SQL direto | PR #20 |
| 18/10/2026 | Revisão de código | Risco de mensagem em dobro e de tentativa para quem já respondeu | Claim atômico e checagem da conversa antes de cada tentativa | PR #20 |
| 18/10/2026 | Teste em produção | A condição de tag da automação do Hoppe nunca dispara | Automação sem condição; o webhook filtra pela tag `abordar-ia` | PR #21 |
| 18/10/2026 | Teste em produção | O Hoppe dá erro 500 ao adicionar tag com corpo vazio | Envio com corpo `{}` | PR #22 |
| 19/10/2026 | Revisão do Tiago | A retomada de pendência (sócios, horário, e-mail) nunca disparava: a checagem bloqueava por causa da própria resposta do lead | Checagem própria da retomada | PR #31 |
| 19/10/2026 | Produção (Thaissa, Aline, Vinicius, Leandro) | Resposta automática do WhatsApp Business do lead contava como resposta: parava as tentativas e a IA conversava com o robô | Mensagem segundos depois da tentativa, ou com frase típica de saudação/ausência nos primeiros 10 min, é marcada como automática: não muda o estado e a IA não responde | PR #34 |
| 19/10/2026 | Produção (Cleber) | O agente encaminhou pro suporte uma ideia de automação do lead ("gerar o arquivo de importação", "fazer o contrato sozinho") | Prompt: pedido de automação é oportunidade, não suporte; aprofunda e segue a qualificação sem prometer que o produto faz pronto | PR #36 |
| 19/10/2026 | Produção (Cleber) | Horário oferecido como "ter, 20/10 às 10h", com cara de sistema | Rótulo como gente fala: "amanhã às 10h", "quinta às 14h", e data só a partir de 7 dias | PR #40 |
| 19/10/2026 | Produção (Cleber) | Lead pediu "semana que vem" e a consulta só devolvia horários seguidos do primeiro dia livre | Consulta espalha 2 horários por dia (manhã a partir das 10h, tarde a partir das 14h) e aceita "a partir de" uma data; devolve a data de hoje pro agente calcular | PR #41 |
| 19/10/2026 | Produção (Vandrei) | O agente anunciou "vou chamar o suporte" ao encaminhar | Regra explícita no estilo: nunca falar de suporte, time ou de chamar alguém; "deixa eu te ajudar com isso" | PR #42 |
| 19/10/2026 | Produção (Vandrei) | Agente avisou o lead e encaminhou pra Lívia, mas a Lívia só entrou 4 min depois, quando o lead escreveu de novo | No runner a primeira ação final vencia (resposta antes da delegação); agora DELEGATED prevalece sobre REPLIED e o novo agente é encadeado na hora | PR #43 |
| 19/10/2026 | Produção (Jailson) | A Lívia pediu transferência pro humano (aula não achada), o lead resolveu sozinho e seguiu agendando; a aprovação chegou 15 min depois e desligou a IA no meio do agendamento | Transferência aprovada não desliga a IA se a IA respondeu na conversa depois do pedido (fica registrada como `conversa_seguiu`) | PR #44 |
| 19/10/2026 | Tiago (meta de 3 agendamentos/dia) | 3ª tentativa e 2ª retomada só se despediam ("vou parar de te chamar") | As duas agora oferecem o diagnóstico com o Pedro | PR #45 |
| 19/10/2026 | Produção (Sérgio, Marcio, Vandrei) | Lead que caiu no suporte (Lívia) e disse "ok/obrigado" ficava parado lá pra sempre | Retomada de 24h devolve a conversa pro onboarding e pergunta se deu certo | PR #45 |
| 19/10/2026 | Tiago | Compradores sem formulário vão ser abordados; o agente não tinha o que perguntar | Contexto marca SEM FORMULÁRIO e o prompt manda descobrir a maturidade no caminho | PR #45 |
| 19/10/2026 | Tiago (meta de 3 agendamentos/dia) | Lead de faturamento alto recebia o mesmo ritmo dos outros | Contexto marca PRIORIDADE ALTA (R$ 200 mil/mês pra cima) e o agente convida na primeira resposta | PR #45 |
| 19/10/2026 | Tiago ("tá agendando muito rápido e a qualificação?") | O agente convidava depois de 1 ou 2 perguntas e só perguntava faturamento na hora do e-mail; sem faturamento agendava mesmo assim | Qualificação antes do convite (o que faz, uso de IA, faturamento sempre confirmado, decisor). Trava no código: sem registrarQualificacao = qualificado com faturamento confirmado, consultar horário e agendar são recusados | PR #47 |
| 19/10/2026 | Tiago | Diagnósticos não entravam na agenda do Tiago e os horários oferecidos não olhavam a disponibilidade dele | tiago@asv.digital entra em todo convite e a consulta de horários cruza a agenda dele (passo de 30 min, "11h30"); sem acesso à agenda dele, não oferece horário | PR #48 |
| 18/10/2026 | Teste em produção | O número do WhatsApp pode ter JID sem o 9º dígito | O JID real é resolvido no Zappfy (`/chat/check`) | PR #20 |
