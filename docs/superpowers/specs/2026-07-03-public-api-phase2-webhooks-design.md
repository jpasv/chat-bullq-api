# Public API — Fase 2: Webhooks / Subscriptions (Design)

**Data:** 2026-07-03
**Status:** Aprovado para implementação
**Escopo:** Fase 2 da API pública "estilo Umbler Talk". Depende da Fase 1 (mergeada).

---

## 1. Objetivo

Permitir que sistemas externos **assinem eventos** do Chat BullQ e recebam
callbacks HTTP assinados quando esses eventos ocorrem — o análogo dos webhooks
da Umbler. Terceiro registra uma *subscription* (URL + lista de eventos + secret)
via API pública; um consumidor dedicado entrega os eventos com HMAC, retry e log.

**Fonte de eventos:** os 6 `AutomationTrigger` já emitidos no `OutboxEvent`
(`MESSAGE_RECEIVED`, `CONVERSATION_CREATED`, `CONVERSATION_STATUS_CHANGED`,
`CONVERSATION_ASSIGNED`, `TAG_ADDED`, `TAG_REMOVED`). Nenhuma fonte nova.

---

## 2. Princípios

- **Aditivo.** Não altera comportamento existente. A única modificação em arquivo
  existente é um hook de fan-out no `AutomationEventProcessor` (≈3 linhas,
  não-bloqueante). Todo o resto é código novo.
- **Decoupled.** A entrega de webhook é independente das automações: roda para
  todo evento, mesmo com o kill-switch de automações desligado e mesmo que o
  executor de automações falhe. Falha no dispatch nunca quebra a automação.
- **Idempotente.** Entregas são dedupadas por `jobId = subscriptionId:outboxEventId`
  na fila BullMQ, tornando o dispatch seguro contra retries e re-claim de lease.
- **Thin payload.** O corpo carrega IDs (contactId, conversationId, messageId…);
  o assinante busca detalhes via API da Fase 1. Sem hidratação de entidades.

---

## 3. Ponto de integração (fan-out)

O `outbox-poller` enfileira um job `automation-event` para **todo** `OutboxEvent`
claimed, e o `AutomationJobData` já carrega `{ organizationId, trigger, payload,
outboxEventId, traceId }`. Logo, `AutomationEventProcessor.process(job)` é o
**ponto único** por onde todo evento passa, com todos os dados necessários — sem
query extra.

Hook (topo de `process()`, antes do kill-switch, em try/catch que nunca relança):

```ts
// dispatch de webhooks — independente de automações; nunca quebra o job
try {
  await this.webhookDispatch.dispatch(job.data);
} catch (err) {
  this.logger.warn(`webhook dispatch falhou para outbox=${job.data.outboxEventId}: ${err.message}`);
}
```

---

## 4. Modelos novos (Prisma)

```prisma
enum WebhookDeliveryStatus { PENDING SUCCESS FAILED DLQ }

model WebhookSubscription {
  id                  String   @id @default(cuid())
  organizationId      String   @map("organization_id")
  url                 String
  secret              String                       // gerado no create (whsec_...)
  events              AutomationTrigger[]           // triggers assinados
  isActive            Boolean  @default(true) @map("is_active")
  description         String?
  consecutiveFailures Int      @default(0) @map("consecutive_failures")
  disabledAt          DateTime? @map("disabled_at")
  createdById         String?  @map("created_by_id")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  deliveries   WebhookDelivery[]

  @@index([organizationId, isActive], name: "idx_websub_org_active")
  @@map("webhook_subscriptions")
}

model WebhookDelivery {
  id             String                @id @default(cuid())
  subscriptionId String                @map("subscription_id")
  outboxEventId  String?               @map("outbox_event_id")
  type           String                // nome do trigger OU "PING" — String (não enum) p/ acomodar ping de teste
  payload        Json
  status         WebhookDeliveryStatus @default(PENDING)
  attemptCount   Int                   @default(0) @map("attempt_count")
  responseStatus Int?                  @map("response_status")
  lastError      String?               @map("last_error") @db.Text
  createdAt      DateTime              @default(now()) @map("created_at")
  deliveredAt    DateTime?             @map("delivered_at")

  subscription WebhookSubscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)

  @@index([subscriptionId, createdAt(sort: Desc)], name: "idx_delivery_sub_time")
  @@map("webhook_deliveries")
}
```

Relação inversa `webhookSubscriptions WebhookSubscription[]` adicionada em
`Organization` (aditivo). Migration Prisma nova.

---

## 5. Entrega

Fila BullMQ dedicada `WEBHOOK_QUEUE = 'webhook-deliveries'` (via
`BullModule.registerQueue`, padrão do projeto).

**`WebhookDispatchService.dispatch(event: AutomationJobData)`**
1. Busca `WebhookSubscription` ativas onde `organizationId = event.organizationId`
   e `events` contém `event.trigger`.
2. Para cada, cria uma `WebhookDelivery` (PENDING) e enfileira job
   `{ deliveryId }` com `jobId = ${subscriptionId}:${outboxEventId}` e
   `{ attempts: MAX_WEBHOOK_ATTEMPTS, backoff: { type:'exponential', delay: 5000 } }`.

**`WebhookDeliveryProcessor` (@Processor WEBHOOK_QUEUE)**
1. Carrega `WebhookDelivery` + `subscription`. Se subscription inativa → marca
   delivery DLQ e sai (não entrega em subscription desativada).
2. Monta corpo (§6), assina HMAC-SHA256, POST com timeout (10s).
3. **2xx** → delivery SUCCESS (`deliveredAt`, `responseStatus`); zera
   `subscription.consecutiveFailures`.
4. **Não-2xx / timeout / erro de rede** → grava `lastError`/`responseStatus`,
   `attemptCount++`, e **relança** → BullMQ faz retry com backoff.
5. **Attempts esgotados** (evento `failed` do worker, ou último attempt) →
   delivery DLQ; `subscription.consecutiveFailures++`; se
   `consecutiveFailures >= WEBHOOK_AUTO_DISABLE_AFTER` → **auto-desativa**
   (`isActive=false`, `disabledAt=now`) e emite uma `Notification` ao dono
   (reusa o módulo `notifications`).

Constantes novas em `automations.constants.ts` ou um `webhooks.constants.ts`:
`MAX_WEBHOOK_ATTEMPTS = 5`, `WEBHOOK_AUTO_DISABLE_AFTER = 10`,
`WEBHOOK_TIMEOUT_MS = 10_000`.

---

## 6. Corpo e assinatura do webhook (outbound)

**Corpo** (thin):
```json
{
  "id": "<deliveryId>",
  "type": "MESSAGE_RECEIVED",
  "createdAt": "2026-07-03T12:00:00.000Z",
  "organizationId": "<orgId>",
  "data": { "contactId": "...", "conversationId": "...", "channelId": "...", "messageId": "..." }
}
```

`data` é o payload do outbox mapeado por um `webhook-payload.mapper.ts`, expondo
só IDs públicos por trigger (a partir dos shapes reais):
- `MESSAGE_RECEIVED` → `{ contactId, conversationId, channelId, messageId }`
- `CONVERSATION_CREATED` → `{ contactId, conversationId, channelId }`
- `CONVERSATION_STATUS_CHANGED` → `{ contactId, conversationId, channelId, fromStatus, toStatus }`
- `CONVERSATION_ASSIGNED` → `{ contactId, conversationId, channelId, fromAssigneeId, toAssigneeId }`
- `TAG_ADDED` / `TAG_REMOVED` → `{ contactId, conversationId?, tagId }`

**Headers:**
- `X-BullQ-Event: <trigger>`
- `X-BullQ-Delivery: <deliveryId>`
- `X-BullQ-Signature: sha256=<hex(HMAC-SHA256(rawBody, subscription.secret))>`
- `Content-Type: application/json`

O assinante valida recomputando o HMAC do corpo cru com o secret.

---

## 7. API pública (gestão de subscriptions)

Todos sob `public/webhooks`, com `ApiKeyAuthGuard` + `ApiKeyThrottleGuard` +
escopo por org, seguindo o padrão da Fase 1 (controllers finos + mappers/DTOs).

| Método + rota | Descrição |
|---|---|
| `POST /public/webhooks` | Cria subscription (`url`, `events[]`, `description?`). Retorna o `secret` **uma vez**. |
| `GET /public/webhooks` | Lista subscriptions da org (secret mascarado). |
| `GET /public/webhooks/:id` | Detalha (secret mascarado). |
| `PATCH /public/webhooks/:id` | Atualiza `url`, `events`, `isActive`, `description`. |
| `DELETE /public/webhooks/:id` | Remove. |
| `GET /public/webhooks/:id/deliveries` | Log paginado de entregas (`toPublicPage`). |
| `POST /public/webhooks/:id/ping` | Enfileira uma entrega de teste (`type: "PING"`). |

Mappers: `webhook-subscription.mapper.ts` (mascara `secret`, expõe
`consecutiveFailures`/`isActive`/`disabledAt`), `webhook-delivery.mapper.ts`.
DTOs: `create-webhook.public.dto.ts` (valida `url` http/https e `events` ∈ enum),
`update-webhook.public.dto.ts`.

O `POST /:id/ping` cria uma `WebhookDelivery` sintética `type: 'PING'` com
`data: { ping: true }` e enfileira — exercita o caminho de entrega/assinatura
sem depender de um evento real.

---

## 8. Módulo

Novo `WebhooksModule` (em `src/modules/webhooks/`):
- Providers: `WebhookDispatchService`, `WebhookDeliveryProcessor`,
  `WebhookSubscriptionsService`.
- Registra `WEBHOOK_QUEUE`.
- Exporta `WebhookDispatchService` (consumido pelo `AutomationEventProcessor`).
- Controllers públicos (API-key): registrados no `PublicApiModule` (que importa `WebhooksModule`).
- Controller interno (JWT): expõe os mesmos CRUD reusando `WebhookSubscriptionsService`,
  para o Admin (front) consumir com o padrão de auth do resto do app (ver §11.4).

`AutomationsModule` importa `WebhooksModule` (para o processor injetar
`WebhookDispatchService`) — dependência unidirecional, sem ciclo.

---

## 9. Front — Página no Admin

Nova página de gestão de webhooks em `settings` (`chat-bullq-web`), seguindo o
padrão da Fase 1:
- Rota `src/app/(dashboard)/settings/webhooks/`.
- Criar/listar/editar/remover subscriptions; ao criar, exibe o `secret` uma vez
  (modal, igual ao fluxo de API-key).
- Ver log de entregas recentes por subscription (status, código HTTP, timestamp)
  e botão "Enviar ping".
- Service `webhooks.service.ts` em `features/settings/services/` consumindo os
  endpoints `public/webhooks` (ou os internos equivalentes — ver §11).

---

## 10. Testes

- **Unit:** `webhook-payload.mapper` (cada trigger → data pública correta);
  assinatura HMAC (corpo conhecido → assinatura esperada); `WebhookDispatchService`
  (filtra subscriptions por org+trigger, cria delivery, enfileira com jobId
  idempotente) com prisma/queue mockados; lógica de auto-desativar
  (consecutiveFailures ≥ limite → isActive=false).
- **Integração leve:** `WebhookDeliveryProcessor` com HTTP mockado — 2xx marca
  SUCCESS e zera failures; erro relança; subscription inativa vira DLQ.
- Padrão Jest existente (specs colocados, deps mockadas). `yarn test`.

---

## 11. Riscos / pontos a resolver no plano

1. `AutomationEventPayload` — os IDs exatos por trigger já foram confirmados
   (§6). O mapper cobre os 6 + PING.
2. Emissão de `Notification` no auto-desativar — confirmar a assinatura de
   `NotificationsService` (tipo/args) no plano.
3. Registro de fila BullMQ e config de Redis — reusar o padrão de
   `automations.module.ts` (`BullModule.registerQueue`).
4. Front: confirmar se a página do Admin consome os endpoints `public/webhooks`
   (com API-key) ou se precisa de endpoints internos autenticados por JWT
   (o padrão do resto do Admin é JWT). **Decisão default:** expor os endpoints
   também no controller interno (JWT) reusando o `WebhookSubscriptionsService`,
   como o resto do Admin faz — evitando o front depender de API-key.
5. `Organization` relation inversa e a migration — gerar com
   `prisma migrate dev` e revisar o SQL.
