# Agente de onboarding pós-venda: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lead marcado com a tag `abordar-ia` na list *Leads onboarding* do Hoppe recebe 3 tentativas de abordagem pelo WhatsApp 1258. Se responder, é qualificado por um agente de IA e, se passar, sai com um Diagnóstico de IA de 1h agendado com o Pedro. O Hoppe é atualizado em cada passo.

**Architecture:** Módulo NestJS novo, `lead-onboarding`, no padrão do `sales-recovery`. Uma tabela local `onboarding_leads` guarda o estado de cada lead. Um cron BullMQ a cada 2 min executa as ações vencidas (`next_action_at`). Um webhook recebe a automação do Hoppe. Um hook no pipeline de inbound detecta respostas e intervenção humana. O agente é fixado por `activeAgentId` na conversa e não fica vinculado ao canal, então as outras conversas do 1258 continuam sem IA. O contexto do lead entra no prompt via `conversation.metadata.promptContext`.

**Tech Stack:** NestJS 11, Prisma 6, BullMQ, Jest, axios, Google Calendar API v3, API pública do Hoppe v2.

**Spec:** `docs/superpowers/specs/2026-10-18-lead-onboarding-ia-design.md`

## Global Constraints

- O repositório é o da Bravy: `jpasv/chat-bullq-api`, branch `feat/lead-onboarding-ia` criada de `origin/main`. Nunca usar a branch `nairio-main`.
- Org `cmoomwo0i0001o507ncfq79h9`. Canal Zappfy "Tiago 1258": `cmqjgk9y85iqvqt08y960qahq`.
- Hoppe:
  - list `8c1d6462-7541-4c2e-8a5e-020b3b635459`, space `42ca26dd-f901-41ec-89fb-536697fc2799`;
  - campo Atividade `4227b019-f6e9-4737-b6d7-3a85d2b6fbd5` (`Ativo`/`Inativo`);
  - campos WhatsApp `43f9e1ec-9162-448b-9986-8e7f857514c0` e Faturamento mensal `926f2dff-a7f5-4dc4-b4c5-1ea522b16cb5`;
  - status: nova oportunidade `d3d79a52-98a2-41fa-9dea-e011f660dca3`, em qualificação `dbff0b45-5fae-499d-b86d-7b8bccf43f1d`, reunião agendada `74fb723e-ccc0-49e0-8c02-33d4e2d86405`, desqualificado `f673a940-cde4-4dde-be1d-1544c08f786f`;
  - tags `1º mensagem`, `2º mensagem` e `3º mensagem`.
- Agenda: `c_55cdee99edda8d74bf087dbb90bad897e560de7a5bcfb2ec504384fb08ff112e@group.calendar.google.com`, na conta `produtos@asv.digital` (credencial `GOOGLE_OAUTH_*` existente).
- Cadência: 0h, depois +4h, depois +24h; inativa 24h após a 3ª. Envio só entre 8h e 20h America/Sao_Paulo. Teto de 30 primeiras mensagens por dia.
- Diagnóstico: 60 min, das 9h às 20h, todos os dias, a partir de amanhã.
- Qualificação: Faturamento mensal ≥ R$ 50k (faixas "R$ 50.000 a R$ 200.000", "R$ 200.000 a R$ 1 milhão" e "Acima de R$ 1 milhão"), decisor e prioridade média ou alta.
- Silêncio não desqualifica: Atividade = `Inativo` e o status continua `nova oportunidade`.
- Rio = DDD 21.
- Copy das mensagens 1 a 3 e da retomada: literal do spec, seção "Script de mensagens".
- Arquivos em kebab-case, comentários em português e densidade igual à do `sales-recovery`.

## Review Focus

1. A eco de uma mensagem enviada pelo próprio sistema ou pela IA não pode ser tomada como "Tiago assumiu". Só uma eco nova, que não bate com nenhum outbound recente, pausa a IA. Teste na Task 4.
2. Uma conversa já existente no 1258 com aquele telefone (o Tiago já fala com a pessoa) não é sequestrada. O lead é pulado e comentado. Teste na Task 3.
3. O webhook duplicado ou com payload desconhecido não cria um lead duplicado nem dá 500. Teste na Task 2.
4. Uma tentativa que vence fora da janela de envio (ex.: 23h) é adiada para as 8h e não é enviada. Teste na Task 1.
5. Um lead com opt-out ou pausado nunca recebe tentativa, mesmo que a tag seja adicionada de novo. Teste nas Tasks 2 e 3.

---

### Task 1: Schema, config e regras puras

**Files:**
- Modify: `prisma/schema.prisma` (model `OnboardingLead`)
- Create: `prisma/migrations/20261018200000_add_onboarding_leads/migration.sql`
- Create: `src/modules/lead-onboarding/lead-onboarding.constants.ts`
- Create: `src/modules/lead-onboarding/lead-onboarding-config.service.ts`
- Create: `src/modules/lead-onboarding/onboarding-rules.ts`
- Test: `src/modules/lead-onboarding/onboarding-rules.spec.ts`

**Interfaces (produz):**
- `OnboardingLead` com as colunas: `id`, `organizationId`, `hoppeTaskId` (único), `contactId?`, `conversationId?`, `phone?`, `state` (string: `PENDING | CONTACTED | REPLIED | INACTIVE | SCHEDULED | DISQUALIFIED | OPTED_OUT | PAUSED | SKIPPED`), `attempt` (int), `nextActionAt?`, `lastAttemptAt?`, `repliedAt?`, `lastInboundAt?`, `summaryDueAt?`, `pendingReason?`, `resumeSentAt?`, `meetingEventId?`, `snapshot` (Json), `createdAt` e `updatedAt`. Índices em (`state`, `nextActionAt`) e em `conversationId`.
- `onboarding-rules.ts`:
  - `adjustToSendWindow(at: Date, startHour = 8, endHour = 20): Date`
  - `nextAttemptDelayHours(attempt: number, cadence: number[]): number | null`
  - `isRio(phone: string | null): boolean`
  - `revenueQualifies(faixa: string | null): boolean | null` (retorna null para desconhecido ou "Prefiro não informar")
  - `renderAttempt(attempt: 1|2|3, lead: LeadSnapshot): string`
  - `firstName(name: string | null): string`
- `LeadSnapshot`: `{ name, firstName, phone, email, produto, progresso, atuacao, equipe, faturamento, estado, gargalo, meta }`, todos `string | null`.
- `LeadOnboardingConfigService`: `orgId`, `channelId`, `agentId`, `webhookSecret`, `calendarId`, `closerEmail`, `cadenceHours` ([4, 24, 24]), `sendWindow` ({ start: 8, end: 20 }), `dailyCap` (30), `enabled`.

- [ ] Testes: o horário 23h de Brasília é ajustado para as 8h do dia seguinte; 10h fica como está; 7h59 vai para as 8h do mesmo dia. `nextAttemptDelayHours(1, [4,24,24])` = 4, `(2)` = 24, `(3)` = 24 (inativação) e `(4)` = null. `isRio('5521990451258')` = true e `isRio('5511975286081')` = false. A faixa "R$ 10.000 a R$ 50.000" não qualifica, "R$ 50.000 a R$ 200.000" qualifica e "Prefiro não informar" dá null. `renderAttempt(1, …)` com progresso "Ainda não tive tempo de começar" contém "ainda não tinha começado com o {produto}"; com progresso vazio usa a variante geral.
- [ ] Rodar `yarn jest onboarding-rules`: tudo FAIL.
- [ ] Implementar. As variantes da mensagem 1 seguem o campo "Progresso com o produto". Um placeholder sem valor nunca vai no texto: sem produto, usa "o produto".
- [ ] Rodar os testes (PASS) e `yarn prisma generate`.
- [ ] Commit `feat(lead-onboarding): schema, config e regras de cadência`.

### Task 2: Hoppe client, webhook e criação do lead

**Files:**
- Create: `src/modules/lead-onboarding/hoppe-leads.client.ts`
- Create: `src/modules/lead-onboarding/hoppe-webhook.controller.ts`
- Create: `src/modules/lead-onboarding/lead-onboarding.repository.ts`
- Test: `src/modules/lead-onboarding/hoppe-webhook.controller.spec.ts`

**Interfaces:**
- `HoppeLeadsClient`:
  - `getTask(taskId): Promise<HoppeLeadTask | null>`, onde `HoppeLeadTask` é `{ id, name, statusName, listId, tags: string[], fields: Record<string, unknown> }` com os campos indexados por nome;
  - `setStatus(taskId, statusId)`, que faz PUT `/api/v2/task/{id}` com `{status}`;
  - `setField(taskId, fieldId, value)`;
  - `addTag(taskId, name)`;
  - `addComment(taskId, text)`, com `{comment_text}`.
  - Erros de rede são relançados. O retry fica com quem chama.
- `extractTaskId(payload: unknown): string | null`: procura `taskId`, `task_id`, `task.id`, `data.taskId`, `data.task.id`, `payload.task.id` e `entityId`, aceitando só UUID.
- O controller é `POST /api/v1/webhooks/hoppe/:secret`, `@Public()`, e responde 200 com `{status}`. Um segredo inválido dá 401. Sem taskId, registra as chaves do payload em WARN e retorna `no_task`. Com taskId, chama `repo.enqueueFromTag(orgId, taskId)`.
- `repo.enqueueFromTag`: faz upsert por `hoppeTaskId`. Se não existir, cria com `PENDING` e `nextActionAt = now`. Se existir em `INACTIVE`, `SKIPPED` ou `DISQUALIFIED`, não faz nada (reabordagem fica fora do escopo). Se estiver em `OPTED_OUT` ou `PAUSED`, não faz nada e registra em log. Retorna `'created' | 'exists'`.

- [ ] Testes: segredo errado dá 401. Payload `{task:{id:UUID}}` cria o lead. O mesmo payload duas vezes dá `exists`, sem criar um segundo. Payload `{foo:1}` dá `no_task`. Um lead com opt-out continua `OPTED_OUT`.
- [ ] Rodar os testes (FAIL), implementar e rodar de novo (PASS).
- [ ] Commit `feat(lead-onboarding): webhook do Hoppe e cliente da API`.

### Task 3: Máquina de estados e cron das tentativas

**Files:**
- Create: `src/modules/lead-onboarding/lead-onboarding.service.ts`
- Create: `src/modules/lead-onboarding/lead-onboarding-tick.cron.ts` (repeat a cada 2 min, `jobId` fixo, no padrão do `RecoveryWatchdogCron`)
- Create: `src/modules/lead-onboarding/onboarding-messenger.service.ts`
- Test: `src/modules/lead-onboarding/lead-onboarding.service.spec.ts`

**Interfaces:**
- `OnboardingMessengerService.send(lead, text): Promise<{conversationId, contactId}>`. Resolve o contato e a conversa como o `RecoveryOutreachService.resolveContact` e o `ensureConversation`, com estas diferenças:
  - não reaproveita uma conversa com `assignedToId`;
  - não reaproveita uma conversa com mensagem OUTBOUND humana nos últimos 30 dias, e nesses casos lança `HumanConversationError`;
  - fixa `activeAgentId = config.agentId`, `aiEnabled = true` e `status = BOT`;
  - grava a mensagem com `metadata.source = 'lead_onboarding_attempt'` e enfileira em `outbound-messages`.
- `LeadOnboardingService.tick(now = new Date())` processa os leads com `nextActionAt <= now`:
  - `PENDING`: busca a task. Se ela não estiver em "nova oportunidade" ou não tiver WhatsApp, vira `SKIPPED` com comentário "ignorado: <motivo>". Se o teto diário estiver atingido ou o horário estiver fora da janela, o `nextActionAt` vai para o próximo horário válido. Caso contrário, envia a tentativa 1. No Hoppe: tag `1º mensagem`, Atividade = Ativo e comentário "1ª tentativa enviada em <data>". Grava o snapshot e o `promptContext` na conversa, depois `attempt = 1`, `state = CONTACTED` e `nextActionAt = adjust(now + 4h)`.
  - `CONTACTED` com attempt 1 ou 2: envia a tentativa seguinte, com tag e comentário. Na 3ª, o `nextActionAt` fica em +24h.
  - `CONTACTED` com attempt 3: vira `INACTIVE`, com Atividade = Inativo, comentário "sem resposta após 3 tentativas (<datas>)" e status inalterado.
  - `REPLIED` com `summaryDueAt <= now`: gera o resumo da conversa (Task 5) e comenta.
  - `REPLIED` com `pendingReason`, `nextActionAt` vencido e sem `resumeSentAt`: envia uma retomada única (texto do spec por motivo) e grava `resumeSentAt`.
- `HumanConversationError` faz o lead virar `SKIPPED` com o comentário "conversa existente com o Tiago no 1258, abordagem manual".
- Uma falha do Hoppe numa escrita é registrada em log e não reverte o envio já feito.

- [ ] Testes, com Prisma, Hoppe e messenger mockados:
  - PENDING dentro da janela envia a tentativa 1, coloca a tag e muda o estado;
  - PENDING às 22h só reagenda para as 8h;
  - com o teto de 30 atingido, só reagenda;
  - task fora de "nova oportunidade" vira SKIPPED;
  - `HumanConversationError` vira SKIPPED com comentário;
  - attempt 3 vencido vira INACTIVE e não chama `setStatus`;
  - lead `OPTED_OUT` nunca é selecionado.
- [ ] Rodar os testes (FAIL), implementar e rodar de novo (PASS).
- [ ] Commit `feat(lead-onboarding): cadência de 3 tentativas com janela e teto diário`.

### Task 4: Hook de inbound (resposta e intervenção humana)

**Files:**
- Modify: `src/modules/messaging/pipeline/inbound-message.processor.ts` (ao lado da chamada `salesRecovery.onInboundReply`)
- Modify: `src/modules/messaging/messaging.module.ts` (importar `LeadOnboardingModule`)
- Test: `src/modules/lead-onboarding/lead-onboarding.inbound.spec.ts`

**Interfaces:**
- `LeadOnboardingService.onInbound(conversationId, { isEcho: boolean; isNew: boolean; text: string | null })`. Não faz nada se a conversa não tiver lead.
  - Mensagem que não é eco, em lead `CONTACTED` ou `INACTIVE`: vira `REPLIED`, com `repliedAt`, `nextActionAt = null`, status no Hoppe "em qualificação", Atividade = Ativo e comentário "lead respondeu" (ou "lead voltou a responder" quando estava INACTIVE).
  - Mensagem que não é eco, em lead `REPLIED`: grava `lastInboundAt`, `summaryDueAt = now + 30min` e limpa `nextActionAt`, cancelando a retomada.
  - Eco nova: se o texto não bate com nenhum OUTBOUND da conversa criado nos últimos 3 min, vira `PAUSED`, com `aiEnabled = false` na conversa e o comentário "Tiago assumiu a conversa; IA pausada". Se bate, não faz nada.

- [ ] Testes cobrindo os quatro casos acima, mais: uma eco cujo texto é igual ao de uma mensagem da IA de 1 min atrás não pausa.
- [ ] Rodar os testes (FAIL), implementar e rodar de novo (PASS). Rodar `yarn typecheck`.
- [ ] Commit `feat(lead-onboarding): detectar resposta do lead e intervenção humana`.

### Task 5: Calendar, tools do agente e contexto no prompt

**Files:**
- Create: `src/modules/lead-onboarding/diagnostic-calendar.service.ts`
- Create: `src/modules/ai-agents/tools/builtin/consultar-horarios-diagnostico.tool.ts`
- Create: `src/modules/ai-agents/tools/builtin/agendar-diagnostico.tool.ts`
- Create: `src/modules/ai-agents/tools/builtin/registrar-qualificacao.tool.ts`
- Create: `src/modules/ai-agents/tools/builtin/registrar-opt-out.tool.ts`
- Modify: `src/modules/ai-agents/tools/tool-registry.service.ts` e `tools.module.ts`. As tools ficam restritas ao agentId de `ONBOARDING_AGENT_ID`, no padrão do `moveRecoveryCard`.
- Modify: `src/modules/ai-agents/runner/prompt-builder.service.ts`. Depois do bloco "Contexto da conversa", mostrar `it.conversation.metadata.promptContext` quando for uma string não vazia, sob o título `═══ Contexto do lead ═══`.
- Test: `src/modules/lead-onboarding/diagnostic-calendar.service.spec.ts` e `src/modules/lead-onboarding/onboarding-tools.spec.ts`

**Interfaces:**
- `DiagnosticCalendarService.freeSlots(from: Date, days = 4, max = 6): Promise<Array<{startIso, label}>>`. Faz POST em freeBusy na agenda nova e devolve blocos de 60 min começando na hora cheia, das 9h às 20h (o último bloco começa às 19h), a partir de amanhã. O `label` sai em pt-BR, como "seg, 20/10 às 14h".
- `DiagnosticCalendarService.create({startIso, attendees, title, description}): Promise<{eventId, meetLink}>`. Antes de criar, confere de novo o freeBusy e lança `SlotTakenError` se o horário já estiver ocupado. Usa `sendUpdates=all` e Meet.
- `LeadOnboardingService.findByConversation(conversationId)`.
- `LeadOnboardingService.recordQualification(leadId, input)`:
  - `qualificado` não muda o status, só comenta com os dados e a oferta sugerida (Rio = DDD 21 e mais de R$ 500k/ano: presencial; mais de 500k fora do Rio: Maestria; senão: "Pedro decide");
  - `aguardando_socios` grava `pendingReason = 'socios'`, `nextActionAt = now + 24h` e comenta;
  - `desqualificado` muda o status para desqualificado, comenta o motivo e grava `state = DISQUALIFIED`;
  - quando há `faturamentoConfirmado`, grava em Faturamento mensal.
- `LeadOnboardingService.recordScheduled(leadId, {eventId, startIso, attendees})`: status "reunião agendada", `state = SCHEDULED` e comentário com a data e os participantes.
- `LeadOnboardingService.optOut(leadId, motivo)`: `state = OPTED_OUT`, `nextActionAt = null` e comentário.
- `LeadOnboardingService.summarize(leadId)`: chama o LLM (`fugu`, 300 tokens) com as últimas 40 mensagens desde o último resumo e comenta "Resumo da conversa: …".
- Tools:
  - `consultarHorariosDiagnostico()` devolve `{slots}`;
  - `agendarDiagnostico({inicioIso, emails[], participantes[]})` cria o evento com título "Diagnóstico de IA – {nome}" e convida também `closerEmail`. A descrição tem só objetivo, pauta e participantes. Devolve `{ok, meetLink}`, ou `{ok:false, error:'horario_ocupado'}`;
  - `registrarQualificacao({resultado, motivo, faturamentoConfirmado?, nivel?, objetivo?, prioridade?, decisor?, socios?})`;
  - `registrarOptOut({motivo})`.
  - Toda tool devolve `{ok:false, error:'conversa_sem_lead'}` quando a conversa não tem lead.

- [ ] Testes:
  - `freeSlots` com o freeBusy ocupando 14h às 15h de amanhã não devolve 14h, e nunca devolve slot às 20h;
  - `agendarDiagnostico` com `SlotTakenError` devolve `horario_ocupado` e não chama `recordScheduled`;
  - `registrarQualificacao` com `desqualificado` chama `setStatus(desqualificado)`, e com `qualificado` e DDD 21 com "Acima de R$ 1 milhão" o comentário contém "presencial";
  - a descrição do evento não contém o faturamento.
- [ ] Rodar os testes (FAIL), implementar e rodar de novo (PASS). Rodar `yarn typecheck` e `yarn jest`.
- [ ] Commit `feat(lead-onboarding): tools de qualificação e agendamento do diagnóstico`.

### Task 6: Módulo, seed do agente, deploy e ativação

**Files:**
- Create: `src/modules/lead-onboarding/lead-onboarding.module.ts` (importado no `AppModule`, `MessagingModule` e `ToolsModule`)
- Create: `prisma/scripts/seed-lead-onboarding-agent.ts`. Faz upsert do `AiAgent` `agent_onboarding_001`: nome "Assistente do Tiago", WORKER, VENDAS, modelo `sakana/fugu-ultra-20260615`, `followUpEnabled = false`, system prompt montado a partir das seções "Como conduzir" até "Retomadas e encerramentos" do spec, sem AiAgentChannel.

- [ ] Rodar `yarn build`, `yarn jest` e `yarn typecheck`, todos verdes.
- [ ] Commit, push de `feat/lead-onboarding-ia`, abrir PR em `jpasv/chat-bullq-api` e fazer o merge (o push na main faz o deploy automático e aplica a migration).
- [ ] Configurar as envs no Coolify (`l11qkkyyyk3dif4iqc8axb4u`): `ONBOARDING_ORG_ID`, `ONBOARDING_CHANNEL_ID`, `ONBOARDING_AGENT_ID=agent_onboarding_001`, `HOPPE_WEBHOOK_SECRET`, `ONBOARDING_CALENDAR_ID`, `ONBOARDING_CLOSER_EMAIL=produtos@asv.digital` e `ONBOARDING_ENABLED=true`.
- [ ] Rodar o seed contra o banco da Bravy (`CHAT_BULLQ_DB_URL`).
- [ ] Criar no Hoppe a automação `TAG_ADDED` (condição tag = `abordar-ia`, escopo LIST) → `call_webhook` na URL de prod.
- [ ] E2E com a task "TESTE IA - Tiago (não mexer)" (`c132c764-f2fd-4f8a-bc12-39af873100d8`, WhatsApp 5521990451258):
  - colocar a tag e conferir o webhook nos logs;
  - conferir que a tentativa 1 chegou no 1258, com tag, Atividade e comentário no Hoppe;
  - responder e conferir o status "em qualificação";
  - conferir que o agente responde.
- [ ] Ativar 2 leads reais em "nova oportunidade" com WhatsApp válido, escolhidos com o Tiago, e acompanhar as respostas.
