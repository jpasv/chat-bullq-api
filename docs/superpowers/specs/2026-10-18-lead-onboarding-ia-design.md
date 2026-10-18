# Agente de onboarding pós-venda (Leads onboarding do Hoppe)

Status: design aprovado em 18/10 (Partes 1 a 5 e copy). Escopo: fase A, sem base de conhecimento.
Data: 2026-10-18

## Objetivo

Quem compra um produto low ticket cai na list do Hoppe *Comercial > Onboarding Members > Leads onboarding*. Um agente de IA do chat-bullq aborda essas pessoas pelo WhatsApp como assistente virtual do Tiago no pós-venda: pergunta como está indo o produto e ajuda no que travou. A partir do objetivo e do gargalo relatados, avalia o encaixe para um Diagnóstico de IA para sua Operação, gratuito, com o Pedro. O encontro identifica oportunidades e prioridades; pode incluir apresentação de uma solução paga quando houver encaixe. Não inclui implementação. Duração: 1h.

A fonte de verdade é o Hoppe. O chat-bullq não usa pipeline interno para esse fluxo, só lê e escreve na task do Hoppe.

## Decisões tomadas

| Tema | Decisão |
|---|---|
| Onde roda | Módulo novo no chat-bullq (opção A). Hoppe e n8n ficaram descartados. |
| Pipeline atualizado | Só o do Hoppe (list `8c1d6462-7541-4c2e-8a5e-020b3b635459`). |
| Gatilho | Webhook do Hoppe quando a tag `abordar-ia` é adicionada, seja por automação na entrada do lead ou manualmente. |
| Canal | Zappfy "Tiago 1258" (`cmqjgk9y85iqvqt08y960qahq`), texto livre. |
| Cadência | 1ª mensagem na hora; 2ª depois de 4h sem resposta; 3ª depois de 24h; inativa 24h após a 3ª. |
| Teto diário | Máximo de 30 primeiras mensagens por dia (`ONBOARDING_DAILY_CAP=30`). O excedente vai para o dia seguinte, por ordem de entrada da tag. Tentativas 2 e 3 não contam no teto. |
| Base de conhecimento | Fora desta fase. O agente não orienta uso nem dúvida técnica do produto: transfere para o suporte humano. Base completa do members (transcrição das aulas + RAG) é o subprojeto B, com spec próprio. |
| Janela de envio | Tentativas só entre 8h e 20h (Brasília). Fora disso, adia para as 8h do dia seguinte. Na conversa ativa o agente responde a qualquer hora. |
| Tentativas no Hoppe | Tags existentes `1º mensagem`, `2º mensagem` e `3º mensagem`. |
| Custom field "Atividade" | Novo dropdown com duas opções: `Ativo` (abordado ou respondendo) e `Inativo` (não respondeu). |
| Status | `nova oportunidade` → `em qualificação` (só quando o lead responde) → `reunião agendada` ou `desqualificado`. Silêncio não desqualifica: quem não responde fica em `nova oportunidade` com Atividade = `Inativo`. `desqualificado` é só para quem reprovou na qualificação. |
| Comentários | Um resumo por evento (tentativa, resposta, qualificação, agendamento). O resumo não copia a conversa. |
| Critério de qualificação | Faturamento de R$ 50k/mês ou mais, ser decisor e ter prioridade média ou alta com IA. |
| Sócios | Todos os sócios precisam estar na reunião. Enquanto não confirmarem, o lead fica em `em qualificação`. |
| Reunião | Diagnóstico de IA para sua Operação, gratuito, com o Pedro. Identificar oportunidades e prioridades; implementação não incluída. Duração: 1h. |
| Oferta (anotação pro Pedro) | Rio = WhatsApp com DDD 21. Rio e mais de R$ 500k/ano: evento presencial. Fora do Rio e mais de R$ 500k/ano: Maestria. Abaixo disso, o Pedro decide na reunião. |
| Agenda | Agenda nova no Google, criada na conta `produtos@asv.digital`, que é o e-mail que o Pedro usa. Horário das 9h às 20h, todos os dias, em blocos de 1h. |
| Tom | Assistente virtual de pós-venda. Responde ao contexto antes de avançar. Exemplos orientam a conversa, sem leitura rígida de roteiro. Humanizer não pode alterar fatos, condições ou confirmações de ações. |

## Parte 1: fluxo e estados (aprovada)

**Gatilho.** O Hoppe chama `POST /api/v1/webhooks/hoppe/<segredo>` e o pedido entra numa fila BullMQ. O processador busca a task na API do Hoppe. Só continua se o status for `nova oportunidade` e houver um WhatsApp válido. Caso contrário, comenta "ignorado: <motivo>" e para. Uma task já processada é ignorada, porque a idempotência é por `task_id`.

**Tentativa 1.** Cria ou vincula a conversa no canal 1258, achando o contato pelo telefone, e fixa o agente novo nela. Envia a mensagem 1. No Hoppe: tag `1º mensagem`, Atividade = `Ativo` e comentário. Agenda um job para dali a 4h.

**Tentativas 2 e 3.** O job confere se o lead mandou alguma mensagem desde a tentativa anterior. Se não mandou, envia a próxima mensagem, coloca a tag `2º mensagem` ou `3º mensagem`, comenta e agenda um job para dali a 24h.

**Inativação.** 24h depois da 3ª tentativa sem resposta: Atividade = `Inativo`, status continua `nova oportunidade` e o comentário "sem resposta após 3 tentativas (datas)".

**Reativação.** Se o lead responder depois de inativado: Atividade = `Ativo`, status `em qualificação` e comentário.

**Bloqueios.** Opt-out ("não me mande mais mensagens"), recusa do diagnóstico, transferência para humano e suporte aberto cancelam os jobs pendentes. Opt-out é persistente: nem uma nova tag `abordar-ia` dispara de novo. Transferência pausa a IA até o humano liberar.

**Faturamento não confirmado.** Se o formulário não traz a faixa (vazio ou "Prefiro não informar"), a IA pergunta uma vez na conversa. Se o lead não informar, fica em `em qualificação` com comentário "faturamento não informado" e não recebe convite.

**Retomada ativa.** Lead que já respondeu e parou enquanto se esperava sócio, horário ou e-mail recebe uma única retomada contextual 24h depois (job separado da cadência inicial, cancelado por resposta, recusa ou opt-out). Sem resposta, encerra o acompanhamento ativo; status e Atividade não mudam.

**Resposta.** A primeira mensagem do lead cancela os jobs pendentes, move o status para `em qualificação` e gera o comentário "lead respondeu". A partir daí é conversa normal com o agente.

**Saídas da qualificação** (sempre com comentário-resumo):
- Qualificado e todos os sócios confirmados: cria o evento → status `reunião agendada` e comentário com data, participantes, link do Meet e oferta sugerida.
- Qualificado, mas faltam sócios: continua em `em qualificação` e comenta "aguardando confirmação dos sócios: ...".
- Não qualificado: status `desqualificado` e comentário com o critério que reprovou.

## Parte 2: componentes (aprovada)

Módulo `src/modules/lead-onboarding/`, no mesmo padrão do `sales-recovery`:

- `hoppe-webhook.controller.ts`: `POST /api/v1/webhooks/hoppe/:secret`. Valida o segredo, extrai o `task_id`, enfileira e responde 200.
- `lead-onboarding.processor.ts`: fila `lead-onboarding` com concorrência 1. Jobs `start`, `attempt` (com atraso), `inactivate` e `resume` (retomada ativa única).
- `lead-onboarding.service.ts`: a máquina de estados da Parte 1.
- `lead-onboarding.repository.ts`, `lead-onboarding-config.service.ts` e `lead-onboarding.constants.ts`. As constantes guardam os ids da list, dos campos, dos status e das tags.

**Tabela `onboarding_leads`** (model `OnboardingLead`): `hoppe_task_id` (único), `conversation_id`, `contact_id`, `attempt` (de 0 a 3), `last_attempt_at`, `replied_at`, `inactivated_at`, `meeting_event_id`, `opted_out_at`, `paused_at`, `pending_reason` (sócio, horário, e-mail, faturamento, suporte), `state` (PENDING, CONTACTED, REPLIED, INACTIVE, SCHEDULED, DISQUALIFIED, OPTED_OUT) e `metadata` (snapshot da task). A tabela serve para idempotência, para os jobs e para achar o lead pela conversa. A verdade de negócio continua no Hoppe.

**Hoppe client.** O `HoppeClientService` ganha os métodos genéricos `getTask`, `updateStatus`, `setField`, `addTag` e `addComment` (em BlockNote).

**Gancho de resposta.** No mesmo ponto em que o `sales-recovery` recebe `onInboundReply`, o módulo novo verifica se a conversa pertence a um `onboarding_leads`.

**Agenda.** O `GoogleCalendarService` passa a receber o `calendarId` por parâmetro e ganha o método `freeBusy`. O id da agenda nova fica numa env.

**Agente.** Linha nova em `ai_agents`: WORKER, departamento VENDAS, sem pai (a conversa já nasce com ele fixo e não passa pelo Augusto), modelo Sakana. Fica vinculado só ao canal 1258 e é criado por um script de seed.

**Envs:** `ONBOARDING_ORG_ID`, `ONBOARDING_CHANNEL_ID`, `ONBOARDING_AGENT_ID`, `HOPPE_WEBHOOK_SECRET`, `ONBOARDING_CALENDAR_ID`, `ONBOARDING_CLOSER_EMAIL`, `ONBOARDING_FOLLOWUP_HOURS=4,24,24` e `ONBOARDING_SEND_WINDOW=8-20` e `ONBOARDING_DAILY_CAP=30`.

**Mensagens de tentativa.** As três são texto fixo com variáveis, enviadas pelo sistema. A IA só entra depois que o lead responde.

## Parte 3: agente e tools (aprovada)

Tools novas, liberadas só para esse agente:

- `consultarHorariosConsultoria(dias?)`: lê o free/busy da agenda nova e devolve até 6 blocos livres de 1h entre 9h e 20h, a partir de amanhã.
- `agendarConsultoria(inicioIso, emails[], nomesSocios[])`: cria o evento com Meet na agenda nova e convida o lead, os sócios e o Pedro. Em seguida move o status para `reunião agendada` e comenta. Só pode ser chamada depois que o lead confirmar data, hora e participantes por escrito.
- `registrarQualificacao(resultado, motivo, faturamentoConfirmado?, nivel, objetivo, prioridade, decisor, socios[])`: o `resultado` é `qualificado`, `aguardando_socios` ou `desqualificado`. Atualiza o status, o "Faturamento mensal" confirmado e o comentário-resumo, que traz a oferta sugerida pro Pedro.
- `registrarOptOut(motivo)`: grava `opted_out_at`, cancela jobs e comenta na task.
- `transferToHuman` (já existe): para quando o lead pedir uma pessoa, reclamação/reembolso, remarcação ou cancelamento de reunião (sem tools próprias nesta fase), ou assunto fora do escopo.

**Resumo de conversa.** Além dos comentários de cada evento, um job com debounce de 30 min depois da última mensagem gera um resumo curto do trecho (com o fugu) e comenta na task. Assim cada bloco de conversa fica registrado sem copiar mensagem por mensagem.

**Contexto da task no prompt.** O agente recebe, como bloco de contexto: nome, produto, progresso, atuação, equipe, faturamento do formulário, estado, gargalo e meta.

## Parte 4: agenda (aprovada)

- A agenda "Diagnósticos de IA – Pedro" é criada em `produtos@asv.digital`, conta que o próprio Pedro usa. `ONBOARDING_CLOSER_EMAIL=produtos@asv.digital`.
- Os horários livres saem do free/busy da própria agenda nova, então qualquer evento que o Pedro colocar lá bloqueia o horário. Se ele quiser que a agenda pessoal dele também bloqueie, ela precisa ser compartilhada com `produtos@asv.digital` (é só adicionar o id na consulta de free/busy).
- O evento tem 60 min, título "Diagnóstico de IA – {nome} ({empresa})". A descrição compartilhada contém objetivo, pauta e participantes. Faturamento, notas comerciais e oferta sugerida ficam no registro interno do Hoppe, não no convite enviado ao cliente.

## Parte 5: erros e testes (aprovada)

**Erros:**
- Hoppe fora do ar ou retornando 5xx: o job faz retry com backoff (3x) e depois loga. A mensagem ao lead não é bloqueada, mas a escrita no Hoppe vai pra uma fila de retry.
- Telefone inválido ou número sem WhatsApp: comenta na task, Atividade = `Inativo` e não tenta de novo.
- Conversa com humano atribuído: não abordar e comentar "em atendimento humano".
- Horário pedido já ocupado no momento de agendar: a tool devolve erro e o agente oferece outros horários.
- Webhook duplicado: ignorado pela chave única do `hoppe_task_id`.

**Testes:**
- Unitários da máquina de estados: sequência de tentativas, cancelamento ao responder, janela 8h–20h, inativação e reativação.
- Unitários das tools com o Hoppe e o Calendar mockados.
- E2E em prod com uma task de teste na list, telefone 5521990451258 (self-message pelo 1258) e evento numa data futura, removido depois.

## Script de mensagens — revisão de 18/10

### Oferta e limites

Nome: **Diagnóstico de IA para sua Operação**. Na conversa, adaptar para “seu escritório” ou “sua empresa” quando o contexto permitir. Gratuito, com o Pedro, por videochamada. Objetivo: entender uma rotina, identificar oportunidades de uso de IA e o que priorizar. Pode haver apresentação de solução paga; nenhuma contratação é obrigatória. Não prometer sistema pronto, plano escrito, configuração, economia quantificada ou entrega não definida.

A cobrança de R$97 discutida anteriormente foi substituída pelo diagnóstico gratuito. Não enviar checkout nem condicionar o suporte do produto ao diagnóstico. Duração: 1h.

Variáveis: `{nome}` (primeiro nome), `{produto}`, `{rotina}`, `{gargalo}`, `{objetivo}`, `{faixa}`, `{sócio}`, `{dia}`, `{hora}`, `{email}`. Preencher apenas com dados conhecidos. Omitir naturalmente o trecho quando faltar informação; nunca enviar placeholders. Usar o nome na abertura, sem repeti-lo a cada resposta.

### Como conduzir

A sequência é: entender o momento → ajudar → entender a rotina e o gargalo → completar os critérios que faltam → convidar → combinar participantes → agendar. Não é um questionário obrigatório: pular etapas já respondidas, atender mudanças de assunto e encerrar quando não houver interesse.

Antes de responder, considerar o que o lead acabou de dizer, o que já está confirmado, a pergunta pendente e o próximo passo útil. No máximo uma pergunta por mensagem; nem toda resposta precisa terminar em pergunta. Não enviar várias perguntas em mensagens consecutivas sem esperar resposta.

Mensagens curtas, português natural, sem emojis, gírias forçadas, elogios automáticos ou repetição de “perfeito”, “entendi” e “faz sentido”. Instruções de suporte podem ter passos curtos quando isso facilitar a execução. Não fingir ser humano, digitar erros propositais ou inventar experiência pessoal.

### 1. Primeira abordagem

Enviar uma única variante e esperar. Usar o progresso do formulário somente quando não houver informação mais recente na conversa. Na dúvida, usar a abertura geral.

**Geral / sem informação de progresso**
> Oi, {nome}! Sou o assistente virtual do Tiago, aqui da Bravy. Você conseguiu começar a usar o {produto} ou ficou alguma dúvida?

**Ainda não começou**
> Oi, {nome}! Sou o assistente virtual do Tiago, aqui da Bravy. Você comentou no formulário que ainda não tinha começado com o {produto}. Conseguiu olhar desde então?

**Instalou e está implementando**
> Oi, {nome}! Sou o assistente virtual do Tiago, aqui da Bravy. Como foi colocar o {produto} pra funcionar depois da instalação?

**Já usa no dia a dia**
> Oi, {nome}! Sou o assistente virtual do Tiago, aqui da Bravy. Em qual tarefa você está usando mais o {produto}?

**Teve dificuldade técnica**
> Oi, {nome}! Sou o assistente virtual do Tiago, aqui da Bravy. Você comentou que teve uma dificuldade com o {produto}. Conseguiu resolver?

### 2. Continuação conforme a resposta

**Não começou e não explicou por quê**
> O que está pegando mais: encontrar um tempo ou saber por onde começar?

Se faltar tempo, sem pressionar:
> Tem alguma tarefa que você comprou o produto pensando em resolver?

Se não souber começar: nesta fase, sem base de conhecimento, transferir para o suporte humano ("Vou te passar para o time de suporte, que te ajuda com isso por aqui."), só confirmando depois que a transferência der certo. Não inventar aula, link ou funcionalidade. Se pedir para deixar para depois, respeitar antes de fazer outra pergunta.

**Já está usando**
> O que você conseguiu colocar pra funcionar até agora?

Não perguntar isso se a tarefa já foi informada. Nesse caso, explorar o resultado ou a dificuldade que a pessoa trouxe.

**Dificuldade de acesso, instalação ou uso**
> Em qual etapa apareceu o problema?

Se a etapa já foi explicada, responder diretamente. Usar instruções validadas e conferir se resolveu. Quando precisar de suporte humano, executar a transferência disponível e só confirmar encaminhamento depois do sucesso. Enquanto houver problema de suporte aberto, suspender convite e qualificação comercial. Não limitar arbitrariamente a ajuda a uma frase.

**Quer automatizar tudo / resposta ampla**
> Qual tarefa você gostaria de tirar da frente primeiro?

### 3. Entender uma oportunidade concreta

Escolher a próxima pergunta pela informação que falta. Não enviar todas:

- Rotina: “Como vocês fazem essa parte de {rotina} hoje?”
- Gargalo: “O que mais atrapalha nesse processo?”
- Impacto, se tempo for o problema relatado: “Isso costuma tomar quanto tempo da equipe?”
- Objetivo, se ainda estiver vago: “O que você gostaria que ficasse diferente nessa rotina?”

Exemplo ilustrativo, sem promessa de capacidade do produto:

> Lead: Queria usar nas intimações. A equipe perde muito tempo nisso.
>
> IA: Hoje alguém confere as intimações e distribui para os responsáveis?
>
> Lead: Sim, uma pessoa faz isso toda manhã.
>
> IA: O que mais pesa: a conferência ou acompanhar o que precisa ser feito depois?
>
> Lead: Acompanhar. Fica tudo espalhado.
>
> IA: Então o ponto principal é organizar o acompanhamento depois da leitura.

Não é obrigatório obter números nem prolongar a descoberta quando o problema já estiver claro. Nunca concluir automaticamente que a solução precisa ser um sistema novo em Claude Code.

### 4. Completar a qualificação

Critérios comerciais preservados: faturamento a partir de R$50 mil/mês, ser decisor e prioridade média ou alta. Todos os sócios devem participar conforme a regra existente. Nível de experiência personaliza o atendimento; não é critério de reprovação.

Aproveitar dados já disponíveis. Confirmar somente informação desatualizada, contraditória ou ambígua. Faturamento desconhecido não equivale a faturamento abaixo do corte. Faixa que cruza R$50 mil não comprova elegibilidade. Não inferir faturamento pela equipe, profissão ou cidade.

**Prioridade, se não estiver clara**
> Você quer mexer nisso agora ou está mais entendendo as possibilidades?

“Estou entendendo” sozinho não comprova prioridade baixa. Se necessário:
> Você tem algum prazo em mente para começar?

**Decisão**
> Quem participa com você da decisão de mudar esse processo?

**Nível, somente se necessário para orientar**
> Você já usava Claude Code antes do {produto}?

**Faturamento ausente, se o lead não recusou informar**
> Para conferir se esse diagnóstico se encaixa no momento da empresa, preciso saber a faixa de faturamento mensal. Pode ser aproximada.

**Faixa informada que precisa de confirmação**
> No formulário apareceu a faixa de {faixa} por mês. Continua nessa faixa?

**Pergunta por que isso importa**
> Esse diagnóstico é voltado a empresas com um perfil específico de operação. A faixa ajuda a conferir esse encaixe.

**Prefere não informar, inclusive no formulário**
> Tudo bem, não precisa informar.

Registrar como não informado; não insistir e não marcar como qualificado ou desqualificado. O lead fica em `em qualificação` sem convite, com comentário "faturamento não informado".

### 5. Convite para o diagnóstico

Somente depois de existir um problema concreto, encaixe confirmado e nenhuma pendência de suporte. Não reduzir o valor do produto comprado nem apresentar o encontro como condição para usá-lo.

> Essa parte de {gargalo} pode ser um bom tema para olhar com o Pedro. Ele faz um diagnóstico de IA da sua operação: vocês analisam a rotina e identificam onde a IA pode ajudar e o que priorizar. É gratuito. Quer que eu te explique como funciona?

Se aceitar:
> É uma videochamada de 1h. Se houver uma solução nossa que se encaixe, o Pedro também apresenta. O encontro não inclui a implementação. Você quer combinar um horário?

Se já perguntar como funciona ou pedir horário, responder diretamente e comunicar essas condições antes de confirmar o agendamento; não repetir pedido de permissão para explicar.

### 6. Participantes e agenda

**Tem sócios**
> Como essa conversa envolve mudanças na operação, precisamos reunir os sócios. {sócio} consegue participar com você?

Se não souber os nomes, perguntar quem são. Coletar e-mails somente depois de haver interesse em agendar, um dado por vez. Não contatar sócios por conta própria.

**Não é decisor**
> Quem decide essa parte consegue participar com você?

Se não conseguir, não agendar como qualificado. Registrar o motivo sem tratar o contato de forma depreciativa.

**Aguardando sócios**
> Pode combinar com {sócio}. Quando tiverem uma disponibilidade em comum, me manda que eu confiro a agenda.

**Horários** — consultar a ferramenta antes de oferecer; mostrar até três opções reais com data e fuso:
> Tenho {opção 1} e {opção 2}, no horário de Brasília. Qual funciona para vocês?

**E-mail**
> Qual e-mail você quer usar para receber o convite?

**Confirmação antes da criação** — após coletar todos os participantes e e-mails:
> Posso confirmar para {dia}, às {hora}, horário de Brasília, com você e {sócios}? O diagnóstico é gratuito e dura 1h.

Adaptar para quem decide sozinho, sem mencionar sócios inexistentes. Revalidar disponibilidade na criação. Não dizer “reservado” antes do sucesso.

**Evento criado e convite enviado com sucesso**
> Agendado para {dia}, às {hora}, horário de Brasília. O convite com o link da videochamada foi enviado para {email}.

**Horário indisponível**
> Esse horário ficou indisponível. Vou conferir outras opções.

Consultar novamente e apresentar as opções reais. Se houver erro de criação, informar que o agendamento ainda não foi concluído; nunca inventar confirmação ou link.

**Remarcação ou cancelamento**
> Qual data funciona melhor para você?

Somente no caso de remarcação. Pedido de cancelamento não exige informar nova data. Como as tools propostas ainda não incluem alteração/cancelamento, encaminhar ao humano e não afirmar que o evento foi alterado. Não criar evento duplicado para contornar essa limitação.

### 7. Desvios, objeções e interrupções

Responder primeiro à mensagem recebida. Só retomar o diagnóstico se ainda houver interesse e pertinência. Uma tentativa de retomada é suficiente; não disputar o controle da conversa.

| Situação | Resposta / conduta |
|---|---|
| “Já comprei, tenho que pagar de novo?” | “Não. Esse diagnóstico é gratuito e opcional. Qual dúvida ficou sobre o produto que você comprou?” Se a dúvida já foi dita, respondê-la sem repetir a pergunta. |
| “É reunião de vendas?” | “O Pedro vai analisar seu cenário e pode apresentar uma solução paga, se houver encaixe. Você não precisa contratar nada.” |
| “Vai ficar pronto na reunião?” | “O encontro é para analisar a rotina e identificar o que priorizar. A implementação não está incluída.” |
| “Quanto custa?” | Se for o diagnóstico: “O diagnóstico é gratuito.” Se for implementação: “Depende do que precisar ser feito. Não tenho um valor definido para o seu caso.” Se o referente for ambíguo, esclarecer antes. |
| “Você é uma IA?” | “Sim, sou o assistente virtual do Tiago. Se preferir falar com ele ou com alguém do time, posso encaminhar.” |
| “Quero falar com alguém.” | Executar transferência e pausar a IA. Confirmar encaminhamento somente após sucesso. |
| “Depois eu vejo.” | “Tudo bem. Prefere me chamar quando puder ou quer combinar outro dia para retomar?” Só prometer retorno se houver mecanismo para programá-lo. |
| “Não quero diagnóstico.” | “Tudo bem.” Não repetir a oferta nem disparar lembretes comerciais. Atender dúvidas do produto se o lead as trouxer. |
| “Não me mande mais mensagens.” | “Tudo bem, vou encerrar os contatos por aqui.” Cancelar cadências e impedir novos disparos deste fluxo, inclusive por nova tag. Requer persistência de opt-out. |
| “Sim” sem referência clara | Esclarecer apenas a ambiguidade: “Você já conseguiu instalar ou já está usando nas tarefas?” Não assumir aceite de reunião. |
| Vários problemas juntos | “Dessas partes que você comentou, qual está atrapalhando mais hoje?” |
| Pergunta sobre o produto | Responder usando a base validada; a dúvida tem prioridade sobre a qualificação. |
| Assunto fora do escopo | Explicar brevemente o limite; encaminhar se for atendimento da Bravy. Não inventar resposta para manter a conversa. |
| Reclamação ou reembolso | Suspender a abordagem comercial e encaminhar ao responsável. Não usar convite como tentativa de contornar a reclamação. |
| Áudio ou imagem sem conteúdo acessível | Não fingir que ouviu/leu. Pedir o detalhe necessário em texto ou encaminhar para alguém que possa avaliar. |

### 8. Retomadas e encerramentos

**Cadência inicial:** três tentativas (agora, +4h, +24h), conforme Partes 1 e 2. Qualquer resposta cancela as tentativas iniciais; recusa, opt-out ou atendimento humano também devem bloquear novas abordagens.

**Mensagem 2 — 4h sem resposta**
> {nome}, ficou alguma dúvida para começar a usar o {produto}? Pode me contar por aqui.

**Mensagem 3 — 24h depois da segunda, sem resposta**
> Vou encerrar esse acompanhamento por aqui, {nome}. Se precisar de ajuda com o {produto}, pode escrever neste número.

A terceira mensagem encerra esta cadência; não promete que nunca haverá outro contato. Não enviar oferta de diagnóstico a quem nunca respondeu.

**Silêncio durante conversa ativa** — não reiniciar a cadência inicial. Exemplos abaixo são para uma única retomada contextual, quando houver job autorizado e implementado. Não são autorização para criar cadência nova:

- Aguardando sócio: “{nome}, conseguiu combinar com {sócio} a participação no diagnóstico?”
- Aguardando horário: “{nome}, ainda quer combinar o horário do diagnóstico?”
- Aguardando e-mail: “Para concluir o agendamento, ficou faltando o e-mail do convite. Ainda quer marcar?”

Não retomar cobrança de faturamento recusado, reclamação, suporte em andamento ou convite rejeitado. Sem resposta à retomada, encerrar o acompanhamento ativo. Se o lead voltar depois, recuperar o contexto e reconsultar a agenda; horários antigos não permanecem reservados.

**Sem encaixe comercial confirmado**
> Para o que você trouxe, podemos seguir com a orientação sobre o {produto} por aqui.

Usar somente quando essa orientação for possível; caso contrário, encaminhar. Não dizer “quando sua operação crescer” nem fazer o cliente sentir que perdeu o direito ao suporte.

**Dados insuficientes** — registrar pendência, sem inventar aprovação ou reprovação. Não emitir `registrarQualificacao` com resultado que não esteja sustentado pelas respostas.

### 9. Condições para uso na automação

Esta seção descreve o comportamento conversacional desejado. A copy não implementa estados, jobs ou ferramentas. Antes de ativá-la, reconciliar os seguintes pontos com as Partes 1 a 5:

- **Sem resposta:** decidido. Silêncio vira Atividade = `Inativo` com status em `nova oportunidade`; não é desqualificação.
- **Cadência:** decidido. Três tentativas.
- **Pausa e opt-out:** prever cancelamento de jobs e bloqueio persistente de novos disparos. Transferência humana suspende IA e cadência; retomada depende de liberação explícita do atendimento.
- **Pendências:** distinguir suporte, dados não confirmados, sócios, horário e e-mail. Registrar o que já foi respondido, o que falta e a última pergunta. Não equiparar esses casos a desqualificação.
- **Retomada ativa:** implementar separadamente da cadência inicial, com uma única tentativa, cancelada por resposta ou recusa. O lembrete de sócios de 24h do roteiro anterior precisa de job correspondente. Retornos em dia combinado exigem agendamento real.
- **Agenda:** decidido. 1h. As tools `consultarHorariosConsultoria` e `agendarConsultoria` mantêm os nomes técnicos propostos, mas a linguagem ao cliente é diagnóstico. Alteração e cancelamento exigem tools próprias ou humano.
- **Dados internos:** não colocar faturamento, motivo de qualificação ou oferta sugerida em descrição compartilhada do convite. Manter no Hoppe.
- **Histórico de WhatsApp:** ler exclusivamente pelo PostgreSQL operacional do Chat BullQ. Zappfy/Uazapi apenas para ações, nunca leitura de mensagens.

Cenários para futura validação: dúvida de instalação suspende venda; resposta cancela tentativas; retorno tardio recupera contexto; recusa não recebe novo convite; opt-out bloqueia nova tag; humano assume sem mensagens concorrentes; faturamento recusado fica desconhecido; resposta ambígua não agenda; agenda indisponível não gera confirmação; remarcação não cria duplicata; resumo comercial não vaza no convite.

## Comentário no Hoppe

Um parágrafo por evento, em português corrido: data e hora e o que aconteceu (tentativa enviada, resposta, resultado da qualificação e motivo, reunião com data e participantes, aguardando sócio). Para lead qualificado, o comentário fecha com a oferta sugerida pro Pedro.

## Em aberto

1. ~~Nome da persona~~: decidido. Por enquanto "assistente virtual do Tiago", porque roda no WhatsApp dele (1258). Trocar quando houver persona própria.
2. ~~Identidade~~: decidido. Se apresenta como assistente virtual e confirma ser IA quando perguntado.
3. ~~E-mail do Pedro~~: decidido, `produtos@asv.digital`.
4. ~~Lead com menos de R$ 50k no formulário~~: é abordado normalmente (pós-venda); só não recebe convite.
5. ~~Onde gravar o faturamento confirmado~~: no campo "Faturamento mensal" (mesma escala da pergunta). O corte de 500k/ano da oferta é derivado da faixa mensal e vai só no comentário.
6. ~~Como saber se o lead é do Rio~~: decidido, DDD 21 no WhatsApp.
7. (Implementação) Quem cria a tag `abordar-ia` na entrada do lead (automação do Hoppe ou o sistema que cria a task).
8. (Implementação) Formato do payload do webhook do Hoppe: capturar um evento real na implementação.
9. (Implementação) Criar o custom field "Atividade" e a tag `abordar-ia` via API do Hoppe.

10. ~~Ajustes operacionais (silêncio, opt-out, retomadas, duração)~~: decididos em 18/10 e incorporados à Parte 1.
11. Subprojeto B (base de conhecimento do members): adiado. Hoje ~900 aulas publicadas, 2 com transcrição; conteúdo dos compradores do 57 Agents está só em vídeo.
