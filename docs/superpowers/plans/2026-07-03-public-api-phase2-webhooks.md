# Public API — Fase 2 (Webhooks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar webhooks outbound estilo Umbler — terceiros assinam eventos (URL + events + secret) e recebem callbacks HTTP assinados (HMAC), com retry, log e auto-desativação, reusando o `OutboxEvent` como fonte.

**Architecture:** Novo `WebhooksModule` com modelos `WebhookSubscription`/`WebhookDelivery`, fila BullMQ dedicada, dispatch idempotente e um delivery processor. Fan-out de 1 hook não-bloqueante no `AutomationEventProcessor` (todo evento do outbox flui por ele). Gestão via controller público (API-key) e interno (JWT, pro Admin). **Aditivo** — só o hook toca um arquivo existente.

**Tech Stack:** NestJS 11, Prisma 6, BullMQ, axios, crypto (HMAC), Jest (specs colocados com mocks).

---

## Convenções verificadas (não re-derivar)

- `AutomationJobData` = `{ outboxEventId, organizationId, trigger, payload, traceId, cascadeDepth, visitedAutomations }`. O `AutomationEventProcessor.process(job)` recebe tudo isso.
- Payload por trigger (IDs reais): base `{ organizationId, contactId, conversationId?, channelId?, actorId? }`; `MESSAGE_RECEIVED` add `{ conversationId, channelId, messageId, body, type }`; `CONVERSATION_STATUS_CHANGED` add `{ fromStatus, toStatus }`; `CONVERSATION_ASSIGNED` add `{ fromAssigneeId, toAssigneeId }`; `TAG_ADDED`/`TAG_REMOVED` add `{ tagId }`.
- `NotificationsService.notifyOrgAgents({ organizationId, type, title, body, data? })`; `NotificationType.SYSTEM` existe.
- Fila: `BullModule.registerQueue({ name })`; inject com `@InjectQueue(NAME)`.
- Controller interno: `@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)` + `@CurrentOrg('id')` + `@Roles(...)` (ver `automations.controller.ts`). Guards em `../../common/guards`, decorators em `../../common/decorators`.
- Controller público: `@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)` + `@ApiSecurity('api-key')` + `@CurrentOrg('id')` (padrão Fase 1). `toPublicPage` em `src/modules/public-api/dto/public-page.ts`.
- Test: `*.spec.ts` colocado, instanciar classe com deps mockadas. Rodar `yarn test <path>`.
- axios já é dependência.

---

## Estrutura de arquivos

```
prisma/schema.prisma                       # MODIFICAR: + 2 models, 1 enum, relation inversa em Organization
src/modules/webhooks/
  webhooks.constants.ts                    # CRIAR
  webhooks.module.ts                       # CRIAR
  hmac.util.ts                             # CRIAR (+ .spec.ts)
  webhook-payload.mapper.ts                # CRIAR (+ .spec.ts)
  mappers/
    webhook-subscription.mapper.ts         # CRIAR (+ .spec.ts)
    webhook-delivery.mapper.ts             # CRIAR
  dto/
    create-webhook.public.dto.ts           # CRIAR
    update-webhook.public.dto.ts           # CRIAR
  webhook-subscriptions.service.ts         # CRIAR (+ .spec.ts)
  webhook-dispatch.service.ts              # CRIAR (+ .spec.ts)
  webhook-delivery.processor.ts            # CRIAR (+ .spec.ts)
  public-webhooks.controller.ts            # CRIAR (API-key)
  webhooks.controller.ts                   # CRIAR (JWT interno)
src/modules/automations/workers/automation-event.processor.ts  # MODIFICAR: + hook fan-out
src/modules/automations/automations.module.ts                  # MODIFICAR: + import WebhooksModule
src/modules/public-api/public-api.module.ts                    # MODIFICAR: + import WebhooksModule + PublicWebhooksController
src/app.module.ts                          # MODIFICAR: + WebhooksModule (se controller interno não vier via outro módulo)

chat-bullq-web/src/features/settings/services/webhooks.service.ts      # CRIAR
chat-bullq-web/src/app/(dashboard)/settings/webhooks/page.tsx          # CRIAR
```

---

## Task 1: Prisma — models, enum, migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add enum + models + relation**

Adicionar o enum e os dois models (ver spec §4). Usar `type String` em `WebhookDelivery.type` (acomoda PING):

```prisma
enum WebhookDeliveryStatus {
  PENDING
  SUCCESS
  FAILED
  DLQ
}

model WebhookSubscription {
  id                  String    @id @default(cuid())
  organizationId      String    @map("organization_id")
  url                 String
  secret              String
  events              AutomationTrigger[]
  isActive            Boolean   @default(true) @map("is_active")
  description         String?
  consecutiveFailures Int       @default(0) @map("consecutive_failures")
  disabledAt          DateTime? @map("disabled_at")
  createdById         String?   @map("created_by_id")
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")

  organization Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  deliveries   WebhookDelivery[]

  @@index([organizationId, isActive], name: "idx_websub_org_active")
  @@map("webhook_subscriptions")
}

model WebhookDelivery {
  id             String                @id @default(cuid())
  subscriptionId String                @map("subscription_id")
  outboxEventId  String?               @map("outbox_event_id")
  type           String
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

Adicionar a relação inversa no model `Organization` (localizar o bloco `model Organization` e adicionar na lista de relações):

```prisma
  webhookSubscriptions WebhookSubscription[]
```

- [ ] **Step 2: Generate migration + client**

Run: `yarn prisma migrate dev --name add_webhook_subscriptions`
Expected: cria `prisma/migrations/<ts>_add_webhook_subscriptions/` e regenera o client sem erro.

- [ ] **Step 3: Verify client types**

Run: `yarn prisma generate && yarn typecheck`
Expected: sem erros; `prisma.webhookSubscription` e `prisma.webhookDelivery` disponíveis.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(webhooks): add WebhookSubscription/WebhookDelivery models + migration"
```

---

## Task 2: Constantes

**Files:**
- Create: `src/modules/webhooks/webhooks.constants.ts`

- [ ] **Step 1: Write constants**

```ts
// webhooks.constants.ts
export const WEBHOOK_QUEUE = 'webhook-deliveries';
export const MAX_WEBHOOK_ATTEMPTS = 5;
export const WEBHOOK_BACKOFF_MS = 5_000;
export const WEBHOOK_AUTO_DISABLE_AFTER = 10;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/webhooks/webhooks.constants.ts
git commit -m "feat(webhooks): add constants"
```

---

## Task 3: Assinatura HMAC

**Files:**
- Create: `src/modules/webhooks/hmac.util.ts`
- Test: `src/modules/webhooks/hmac.util.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// hmac.util.spec.ts
import { signPayload } from './hmac.util';
import * as crypto from 'crypto';

describe('signPayload', () => {
  it('gera sha256=<hmac hex> do corpo cru com o secret', () => {
    const body = JSON.stringify({ a: 1 });
    const secret = 'whsec_test';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(signPayload(body, secret)).toBe(expected);
  });

  it('assinaturas diferem quando o secret muda', () => {
    const body = '{"a":1}';
    expect(signPayload(body, 's1')).not.toBe(signPayload(body, 's2'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/webhooks/hmac.util.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// hmac.util.ts
import * as crypto from 'crypto';

export function signPayload(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/webhooks/hmac.util.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhooks/hmac.util.ts src/modules/webhooks/hmac.util.spec.ts
git commit -m "feat(webhooks): add HMAC signer"
```

---

## Task 4: Payload mapper (evento → data pública)

**Files:**
- Create: `src/modules/webhooks/webhook-payload.mapper.ts`
- Test: `src/modules/webhooks/webhook-payload.mapper.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// webhook-payload.mapper.spec.ts
import { mapWebhookData } from './webhook-payload.mapper';

describe('mapWebhookData', () => {
  it('MESSAGE_RECEIVED → ids relevantes', () => {
    const out = mapWebhookData('MESSAGE_RECEIVED', {
      organizationId: 'o', contactId: 'c', conversationId: 'cv', channelId: 'ch', messageId: 'm', body: 'oi', type: 'TEXT', actorId: null,
    });
    expect(out).toEqual({ contactId: 'c', conversationId: 'cv', channelId: 'ch', messageId: 'm' });
  });

  it('CONVERSATION_STATUS_CHANGED → inclui from/toStatus', () => {
    const out = mapWebhookData('CONVERSATION_STATUS_CHANGED', {
      organizationId: 'o', contactId: 'c', conversationId: 'cv', channelId: 'ch', fromStatus: 'OPEN', toStatus: 'CLOSED',
    });
    expect(out).toEqual({ contactId: 'c', conversationId: 'cv', channelId: 'ch', fromStatus: 'OPEN', toStatus: 'CLOSED' });
  });

  it('TAG_ADDED → inclui tagId', () => {
    const out = mapWebhookData('TAG_ADDED', { organizationId: 'o', contactId: 'c', conversationId: 'cv', tagId: 't' });
    expect(out).toEqual({ contactId: 'c', conversationId: 'cv', tagId: 't' });
  });

  it('trigger desconhecido → só campos base disponíveis', () => {
    const out = mapWebhookData('PING', { ping: true } as any);
    expect(out).toEqual({ ping: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/webhooks/webhook-payload.mapper.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// webhook-payload.mapper.ts
// Mapeia o payload interno do outbox para o `data` público do webhook (thin: só IDs).
export function mapWebhookData(type: string, payload: any): Record<string, any> {
  const base = {
    contactId: payload.contactId,
    conversationId: payload.conversationId,
    channelId: payload.channelId,
  };
  switch (type) {
    case 'MESSAGE_RECEIVED':
      return { contactId: payload.contactId, conversationId: payload.conversationId, channelId: payload.channelId, messageId: payload.messageId };
    case 'CONVERSATION_CREATED':
      return { contactId: payload.contactId, conversationId: payload.conversationId, channelId: payload.channelId };
    case 'CONVERSATION_STATUS_CHANGED':
      return { ...base, fromStatus: payload.fromStatus, toStatus: payload.toStatus };
    case 'CONVERSATION_ASSIGNED':
      return { ...base, fromAssigneeId: payload.fromAssigneeId, toAssigneeId: payload.toAssigneeId };
    case 'TAG_ADDED':
    case 'TAG_REMOVED':
      return { contactId: payload.contactId, conversationId: payload.conversationId, tagId: payload.tagId };
    default:
      return { ...payload };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/webhooks/webhook-payload.mapper.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhooks/webhook-payload.mapper.ts src/modules/webhooks/webhook-payload.mapper.spec.ts
git commit -m "feat(webhooks): add outbound payload mapper"
```

---

## Task 5: Mappers de subscription e delivery

**Files:**
- Create: `src/modules/webhooks/mappers/webhook-subscription.mapper.ts`
- Create: `src/modules/webhooks/mappers/webhook-delivery.mapper.ts`
- Test: `src/modules/webhooks/mappers/webhook-subscription.mapper.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// webhook-subscription.mapper.spec.ts
import { mapSubscription } from './webhook-subscription.mapper';

describe('mapSubscription', () => {
  const raw = {
    id: 's1', organizationId: 'o', url: 'https://x/hook', secret: 'whsec_abcdef123456',
    events: ['MESSAGE_RECEIVED'], isActive: true, description: 'meu hook',
    consecutiveFailures: 0, disabledAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
  };

  it('mascara o secret e omite organizationId', () => {
    const out = mapSubscription(raw as any);
    expect(out.secret).toBe('whsec_…3456');
    expect((out as any).organizationId).toBeUndefined();
    expect(out).toMatchObject({ id: 's1', url: 'https://x/hook', events: ['MESSAGE_RECEIVED'], isActive: true, consecutiveFailures: 0 });
  });

  it('inclui o secret cru só quando revealSecret=true (create)', () => {
    const out = mapSubscription(raw as any, true);
    expect(out.secret).toBe('whsec_abcdef123456');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/webhooks/mappers/webhook-subscription.mapper.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementations**

```ts
// webhook-subscription.mapper.ts
export interface PublicSubscription {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  secret: string;
  consecutiveFailures: number;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function maskSecret(secret: string): string {
  return `whsec_…${secret.slice(-4)}`;
}

export function mapSubscription(s: any, revealSecret = false): PublicSubscription {
  return {
    id: s.id,
    url: s.url,
    events: s.events ?? [],
    isActive: s.isActive,
    description: s.description ?? null,
    secret: revealSecret ? s.secret : maskSecret(s.secret),
    consecutiveFailures: s.consecutiveFailures ?? 0,
    disabledAt: s.disabledAt ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
```

```ts
// webhook-delivery.mapper.ts
export interface PublicDelivery {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

export function mapDelivery(d: any): PublicDelivery {
  return {
    id: d.id,
    type: d.type,
    status: d.status,
    attemptCount: d.attemptCount ?? 0,
    responseStatus: d.responseStatus ?? null,
    lastError: d.lastError ?? null,
    createdAt: d.createdAt,
    deliveredAt: d.deliveredAt ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/webhooks/mappers/webhook-subscription.mapper.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhooks/mappers/
git commit -m "feat(webhooks): add subscription/delivery mappers"
```

---

## Task 6: DTOs de request

**Files:**
- Create: `src/modules/webhooks/dto/create-webhook.public.dto.ts`
- Create: `src/modules/webhooks/dto/update-webhook.public.dto.ts`

- [ ] **Step 1: Write the DTOs**

```ts
// create-webhook.public.dto.ts
import { IsUrl, IsArray, IsEnum, ArrayNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AutomationTrigger } from '@prisma/client';

export class CreateWebhookPublicDto {
  @ApiProperty({ example: 'https://meu-sistema.com/webhooks/bullq' })
  @IsUrl({ require_tld: false })
  url: string;

  @ApiProperty({ enum: AutomationTrigger, isArray: true, example: ['MESSAGE_RECEIVED'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(AutomationTrigger, { each: true })
  events: AutomationTrigger[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}
```

```ts
// update-webhook.public.dto.ts
import { IsUrl, IsArray, IsEnum, IsOptional, IsString, IsBoolean, ArrayNotEmpty } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AutomationTrigger } from '@prisma/client';

export class UpdateWebhookPublicDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @ApiPropertyOptional({ enum: AutomationTrigger, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(AutomationTrigger, { each: true })
  events?: AutomationTrigger[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
yarn typecheck
git add src/modules/webhooks/dto/
git commit -m "feat(webhooks): add request DTOs"
```

---

## Task 7: WebhookSubscriptionsService (CRUD)

**Files:**
- Create: `src/modules/webhooks/webhook-subscriptions.service.ts`
- Test: `src/modules/webhooks/webhook-subscriptions.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// webhook-subscriptions.service.spec.ts
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';

describe('WebhookSubscriptionsService', () => {
  const build = () => {
    const prisma = {
      webhookSubscription: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 's1', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: 's1', organizationId: 'o' }),
        update: jest.fn().mockImplementation(({ data }) => ({ id: 's1', organizationId: 'o', ...data })),
        delete: jest.fn().mockResolvedValue({ id: 's1' }),
      },
      webhookDelivery: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    return { prisma, service: new WebhookSubscriptionsService(prisma as any) };
  };

  it('create gera secret com prefixo whsec_ e persiste', async () => {
    const { prisma, service } = build();
    const out = await service.create('o', 'u1', { url: 'https://x/h', events: ['MESSAGE_RECEIVED'] as any });
    expect(prisma.webhookSubscription.create).toHaveBeenCalled();
    expect(out.secret).toMatch(/^whsec_/);
  });

  it('findOne rejeita subscription de outra org', async () => {
    const { prisma, service } = build();
    prisma.webhookSubscription.findFirst.mockResolvedValue(null);
    await expect(service.findOne('s1', 'other')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/webhooks/webhook-subscriptions.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// webhook-subscriptions.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { AutomationTrigger } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { WEBHOOK_SECRET_PREFIX } from './webhooks.constants';

@Injectable()
export class WebhookSubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  private generateSecret(): string {
    return WEBHOOK_SECRET_PREFIX + crypto.randomBytes(24).toString('base64url');
  }

  async create(
    organizationId: string,
    createdById: string | null,
    input: { url: string; events: AutomationTrigger[]; description?: string },
  ) {
    return this.prisma.webhookSubscription.create({
      data: {
        organizationId,
        createdById,
        url: input.url,
        events: input.events,
        description: input.description ?? null,
        secret: this.generateSecret(),
      },
    });
  }

  async findAll(organizationId: string) {
    return this.prisma.webhookSubscription.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, organizationId: string) {
    const sub = await this.prisma.webhookSubscription.findFirst({ where: { id, organizationId } });
    if (!sub) throw new NotFoundException('Webhook subscription not found');
    return sub;
  }

  async update(
    id: string,
    organizationId: string,
    input: { url?: string; events?: AutomationTrigger[]; isActive?: boolean; description?: string },
  ) {
    await this.findOne(id, organizationId);
    // Reativar manualmente zera o contador de falhas.
    const data: any = { ...input };
    if (input.isActive === true) {
      data.consecutiveFailures = 0;
      data.disabledAt = null;
    }
    return this.prisma.webhookSubscription.update({ where: { id }, data });
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    await this.prisma.webhookSubscription.delete({ where: { id } });
    return { deleted: true };
  }

  async listDeliveries(id: string, organizationId: string, page: number, limit: number) {
    await this.findOne(id, organizationId);
    const skip = (page - 1) * limit;
    const [deliveries, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where: { subscriptionId: id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.webhookDelivery.count({ where: { subscriptionId: id } }),
    ]);
    return { deliveries, total };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/webhooks/webhook-subscriptions.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhooks/webhook-subscriptions.service.ts src/modules/webhooks/webhook-subscriptions.service.spec.ts
git commit -m "feat(webhooks): add subscriptions CRUD service"
```

---

## Task 8: WebhookDispatchService (fan-out → fila)

**Files:**
- Create: `src/modules/webhooks/webhook-dispatch.service.ts`
- Test: `src/modules/webhooks/webhook-dispatch.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// webhook-dispatch.service.spec.ts
import { WebhookDispatchService } from './webhook-dispatch.service';

describe('WebhookDispatchService', () => {
  const build = () => {
    const prisma = {
      webhookSubscription: { findMany: jest.fn().mockResolvedValue([{ id: 'sub1' }, { id: 'sub2' }]) },
      webhookDelivery: { create: jest.fn().mockImplementation(({ data }) => ({ id: `del-${data.subscriptionId}`, ...data })) },
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    return { prisma, queue, service: new WebhookDispatchService(prisma as any, queue as any) };
  };

  const event = { outboxEventId: 'evt1', organizationId: 'o', trigger: 'MESSAGE_RECEIVED', payload: { contactId: 'c', conversationId: 'cv', channelId: 'ch', messageId: 'm' } };

  it('cria uma delivery e enfileira um job por subscription ativa', async () => {
    const { prisma, queue, service } = build();
    await service.dispatch(event as any);
    expect(prisma.webhookSubscription.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'o', isActive: true, events: { has: 'MESSAGE_RECEIVED' } },
    });
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('usa jobId idempotente subscriptionId:outboxEventId', async () => {
    const { queue, service } = build();
    await service.dispatch(event as any);
    const opts = queue.add.mock.calls[0][2];
    expect(opts.jobId).toBe('sub1:evt1');
  });

  it('não faz nada quando não há subscription casando', async () => {
    const { prisma, queue, service } = build();
    prisma.webhookSubscription.findMany.mockResolvedValue([]);
    await service.dispatch(event as any);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/webhooks/webhook-dispatch.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// webhook-dispatch.service.ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { WEBHOOK_QUEUE, MAX_WEBHOOK_ATTEMPTS, WEBHOOK_BACKOFF_MS } from './webhooks.constants';
import { mapWebhookData } from './webhook-payload.mapper';

interface DispatchEvent {
  outboxEventId: string;
  organizationId: string;
  trigger: string;
  payload: any;
}

@Injectable()
export class WebhookDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  async dispatch(event: DispatchEvent): Promise<void> {
    const subs = await this.prisma.webhookSubscription.findMany({
      where: { organizationId: event.organizationId, isActive: true, events: { has: event.trigger as any } },
    });
    if (!subs.length) return;

    const data = mapWebhookData(event.trigger, event.payload);
    for (const sub of subs) {
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          outboxEventId: event.outboxEventId,
          type: event.trigger,
          payload: data,
        },
      });
      await this.queue.add(
        'deliver',
        { deliveryId: delivery.id },
        {
          jobId: `${sub.id}:${event.outboxEventId}`,
          attempts: MAX_WEBHOOK_ATTEMPTS,
          backoff: { type: 'exponential', delay: WEBHOOK_BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/webhooks/webhook-dispatch.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhooks/webhook-dispatch.service.ts src/modules/webhooks/webhook-dispatch.service.spec.ts
git commit -m "feat(webhooks): add dispatch service (idempotent fan-out)"
```

---

## Task 9: WebhookDeliveryProcessor (POST + retry + auto-disable)

**Files:**
- Create: `src/modules/webhooks/webhook-delivery.processor.ts`
- Test: `src/modules/webhooks/webhook-delivery.processor.spec.ts`

O processor faz o POST assinado. Sucesso → SUCCESS + zera failures. Falha → relança (retry). Método `handleExhausted(deliveryId)` (chamado no evento `failed` quando `attemptsMade >= attempts`) → marca DLQ, incrementa `consecutiveFailures`, auto-desativa + notifica.

- [ ] **Step 1: Write the failing test**

```ts
// webhook-delivery.processor.spec.ts
import axios from 'axios';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';

jest.mock('axios');
const mockedPost = axios.post as jest.Mock;

const sub = { id: 'sub1', organizationId: 'o', url: 'https://x/h', secret: 'whsec_s', isActive: true, consecutiveFailures: 0 };
const delivery = { id: 'del1', subscriptionId: 'sub1', type: 'MESSAGE_RECEIVED', payload: { contactId: 'c' }, createdAt: new Date('2026-01-01'), subscription: sub };

function build() {
  const prisma = {
    webhookDelivery: { findUnique: jest.fn().mockResolvedValue(delivery), update: jest.fn().mockResolvedValue({}) },
    webhookSubscription: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(sub) },
  };
  const notifications = { notifyOrgAgents: jest.fn().mockResolvedValue(undefined) };
  const proc = new WebhookDeliveryProcessor(prisma as any, notifications as any);
  return { prisma, notifications, proc };
}

beforeEach(() => mockedPost.mockReset());

describe('WebhookDeliveryProcessor', () => {
  it('2xx → marca SUCCESS e zera consecutiveFailures', async () => {
    mockedPost.mockResolvedValue({ status: 200 });
    const { prisma, proc } = build();
    await proc.process({ data: { deliveryId: 'del1' }, attemptsMade: 0 } as any);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS' }) }));
    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 0 }) }));
  });

  it('não-2xx → relança (BullMQ retry)', async () => {
    mockedPost.mockResolvedValue({ status: 500 });
    const { proc } = build();
    await expect(proc.process({ data: { deliveryId: 'del1' }, attemptsMade: 0 } as any)).rejects.toThrow();
  });

  it('handleExhausted → DLQ + incrementa failures + auto-desativa após limite', async () => {
    const { prisma, notifications, proc } = build();
    prisma.webhookSubscription.findUnique.mockResolvedValue({ ...sub, consecutiveFailures: 9 });
    await proc.handleExhausted('del1');
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DLQ' }) }));
    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }));
    expect(notifications.notifyOrgAgents).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/webhooks/webhook-delivery.processor.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// webhook-delivery.processor.ts
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import axios from 'axios';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WEBHOOK_QUEUE, WEBHOOK_AUTO_DISABLE_AFTER, WEBHOOK_TIMEOUT_MS } from './webhooks.constants';
import { signPayload } from './hmac.util';

@Processor(WEBHOOK_QUEUE, { concurrency: 8 })
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<{ deliveryId: string }>): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: job.data.deliveryId },
      include: { subscription: true },
    });
    if (!delivery) return;
    const sub = delivery.subscription;
    if (!sub || !sub.isActive) {
      await this.prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'DLQ', lastError: 'subscription inactive' } });
      return;
    }

    const body = JSON.stringify({
      id: delivery.id,
      type: delivery.type,
      createdAt: delivery.createdAt.toISOString(),
      organizationId: sub.organizationId,
      data: delivery.payload,
    });

    try {
      const res = await axios.post(sub.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-BullQ-Event': delivery.type,
          'X-BullQ-Delivery': delivery.id,
          'X-BullQ-Signature': signPayload(body, sub.secret),
        },
        timeout: WEBHOOK_TIMEOUT_MS,
        validateStatus: () => true, // não lança em não-2xx; decidimos abaixo
      });

      const status = res.status ?? 0;
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SUCCESS', responseStatus: status, deliveredAt: new Date(), attemptCount: (job.attemptsMade ?? 0) + 1 },
      });
      await this.prisma.webhookSubscription.update({ where: { id: sub.id }, data: { consecutiveFailures: 0 } });
    } catch (err) {
      const msg = (err as Error).message;
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', lastError: msg.slice(0, 500), attemptCount: (job.attemptsMade ?? 0) + 1 },
      });
      throw err; // BullMQ retry
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ deliveryId: string }>) {
    // Só age quando os attempts foram esgotados.
    if ((job.attemptsMade ?? 0) < (job.opts?.attempts ?? 1)) return;
    await this.handleExhausted(job.data.deliveryId);
  }

  async handleExhausted(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) return;
    await this.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'DLQ' } });

    const sub = await this.prisma.webhookSubscription.findUnique({ where: { id: delivery.subscriptionId } });
    if (!sub) return;
    const failures = (sub.consecutiveFailures ?? 0) + 1;

    if (failures >= WEBHOOK_AUTO_DISABLE_AFTER) {
      await this.prisma.webhookSubscription.update({
        where: { id: sub.id },
        data: { consecutiveFailures: failures, isActive: false, disabledAt: new Date() },
      });
      await this.notifications.notifyOrgAgents({
        organizationId: sub.organizationId,
        type: NotificationType.SYSTEM,
        title: 'Webhook desativado',
        body: `O webhook ${sub.url} foi desativado após ${failures} falhas consecutivas.`,
        data: { subscriptionId: sub.id },
      });
    } else {
      await this.prisma.webhookSubscription.update({ where: { id: sub.id }, data: { consecutiveFailures: failures } });
    }
  }
}
```

> **Confirmado:** o projeto usa `import axios from 'axios'` direto (não há `@nestjs/axios`). Por isso o processor importa `axios` no módulo e o teste usa `jest.mock('axios')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/webhooks/webhook-delivery.processor.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhooks/webhook-delivery.processor.ts src/modules/webhooks/webhook-delivery.processor.spec.ts
git commit -m "feat(webhooks): add delivery processor (HMAC POST, retry, auto-disable)"
```

---

## Task 10: Ping (teste de entrega) no service

**Files:**
- Modify: `src/modules/webhooks/webhook-subscriptions.service.ts`
- Modify: `src/modules/webhooks/webhook-subscriptions.service.spec.ts`

- [ ] **Step 1: Add failing test**

Adicionar ao spec existente:

```ts
  it('ping cria delivery PING e enfileira', async () => {
    const prisma = {
      webhookSubscription: { findFirst: jest.fn().mockResolvedValue({ id: 's1', organizationId: 'o' }) },
      webhookDelivery: { create: jest.fn().mockResolvedValue({ id: 'delPing' }) },
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new WebhookSubscriptionsService(prisma as any, queue as any);
    await service.ping('s1', 'o');
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'PING' }) }));
    expect(queue.add).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test src/modules/webhooks/webhook-subscriptions.service.spec.ts`
Expected: FAIL — `service.ping` não existe / construtor não aceita queue.

- [ ] **Step 3: Add queue to constructor + ping method**

Modificar o construtor de `WebhookSubscriptionsService` para injetar a fila e adicionar `ping`:

```ts
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WEBHOOK_QUEUE, MAX_WEBHOOK_ATTEMPTS, WEBHOOK_BACKOFF_MS } from './webhooks.constants';

// no construtor:
constructor(
  private readonly prisma: PrismaService,
  @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
) {}

// novo método:
async ping(id: string, organizationId: string) {
  const sub = await this.findOne(id, organizationId);
  const delivery = await this.prisma.webhookDelivery.create({
    data: { subscriptionId: sub.id, type: 'PING', payload: { ping: true } },
  });
  await this.queue.add(
    'deliver',
    { deliveryId: delivery.id },
    { attempts: MAX_WEBHOOK_ATTEMPTS, backoff: { type: 'exponential', delay: WEBHOOK_BACKOFF_MS }, removeOnComplete: true, removeOnFail: false },
  );
  return { queued: true };
}
```

Atualizar os testes anteriores de `WebhookSubscriptionsService` que instanciavam `new WebhookSubscriptionsService(prisma)` para passar um segundo arg mock de fila `{ add: jest.fn() }`.

- [ ] **Step 4: Run to verify it passes**

Run: `yarn test src/modules/webhooks/webhook-subscriptions.service.spec.ts`
Expected: PASS (todos, incluindo o novo ping).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webhooks/webhook-subscriptions.service.ts src/modules/webhooks/webhook-subscriptions.service.spec.ts
git commit -m "feat(webhooks): add ping test-delivery"
```

---

## Task 11: Módulo + wire-up do fan-out

**Files:**
- Create: `src/modules/webhooks/webhooks.module.ts`
- Modify: `src/modules/automations/workers/automation-event.processor.ts`
- Modify: `src/modules/automations/automations.module.ts`

- [ ] **Step 1: Write the module**

```ts
// webhooks.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../database/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WEBHOOK_QUEUE } from './webhooks.constants';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    BullModule.registerQueue({ name: WEBHOOK_QUEUE }),
  ],
  providers: [WebhookSubscriptionsService, WebhookDispatchService, WebhookDeliveryProcessor],
  exports: [WebhookSubscriptionsService, WebhookDispatchService],
})
export class WebhooksModule {}
```

> **Nota:** confirmar o nome/caminho do `PrismaModule` e `NotificationsModule` (rodar `ls src/database/ src/modules/notifications/*.module.ts`). O controller interno `WebhooksController` é adicionado a este módulo na Task 13.

- [ ] **Step 2: Add fan-out hook to the automation processor**

Em `automation-event.processor.ts`: injetar `WebhookDispatchService` e chamar no topo de `process()` num try/catch que nunca relança. NÃO alterar a lógica existente de automação:

```ts
// no construtor, adicionar:
private readonly webhookDispatch: WebhookDispatchService,

// no INÍCIO de process(), antes do kill-switch:
try {
  await this.webhookDispatch.dispatch({
    outboxEventId: job.data.outboxEventId,
    organizationId: job.data.organizationId,
    trigger: job.data.trigger,
    payload: job.data.payload,
  });
} catch (err) {
  this.logger.warn(`webhook dispatch falhou (outbox=${job.data.outboxEventId}): ${(err as Error).message}`);
}
```

Adicionar o import: `import { WebhookDispatchService } from '../../webhooks/webhook-dispatch.service';`

- [ ] **Step 3: Import WebhooksModule in AutomationsModule**

Em `automations.module.ts`, adicionar `WebhooksModule` ao array `imports`:

```ts
import { WebhooksModule } from '../webhooks/webhooks.module';
// ...
imports: [ /* ...existentes..., */ WebhooksModule ],
```

- [ ] **Step 4: Build to verify DI**

Run: `yarn build`
Expected: build ok. Se DI falhar, garantir que `WebhooksModule` exporta `WebhookDispatchService` (já exporta).

- [ ] **Step 5: Run automations tests (garantir que o hook não quebrou nada)**

Run: `yarn test src/modules/automations/`
Expected: specs de automação seguem passando.

- [ ] **Step 6: Commit**

```bash
git add src/modules/webhooks/webhooks.module.ts src/modules/automations/workers/automation-event.processor.ts src/modules/automations/automations.module.ts
git commit -m "feat(webhooks): module + non-blocking fan-out hook in automation processor"
```

---

## Task 12: Controller público (API-key)

**Files:**
- Create: `src/modules/webhooks/public-webhooks.controller.ts`
- Modify: `src/modules/public-api/public-api.module.ts`

- [ ] **Step 1: Write the controller**

```ts
// public-webhooks.controller.ts
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser } from '../../common/decorators';
import { ApiKeyThrottleGuard } from '../public-api/guards/api-key-throttle.guard';
import { toPublicPage } from '../public-api/dto/public-page';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { mapSubscription } from './mappers/webhook-subscription.mapper';
import { mapDelivery } from './mappers/webhook-delivery.mapper';
import { CreateWebhookPublicDto } from './dto/create-webhook.public.dto';
import { UpdateWebhookPublicDto } from './dto/update-webhook.public.dto';

@ApiTags('Public API · Webhooks')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/webhooks')
export class PublicWebhooksController {
  constructor(private readonly service: WebhookSubscriptionsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista webhooks da organização' })
  async list(@CurrentOrg('id') orgId: string) {
    const subs = await this.service.findAll(orgId);
    return { items: subs.map((s) => mapSubscription(s)) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um webhook' })
  async get(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return mapSubscription(await this.service.findOne(id, orgId));
  }

  @Post()
  @ApiOperation({ summary: 'Cria um webhook (retorna o secret uma única vez)' })
  async create(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string, @Body() dto: CreateWebhookPublicDto) {
    const sub = await this.service.create(orgId, userId, dto);
    return mapSubscription(sub, true); // revela o secret
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um webhook' })
  async update(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Body() dto: UpdateWebhookPublicDto) {
    return mapSubscription(await this.service.update(id, orgId, dto));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove um webhook' })
  async remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.remove(id, orgId);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Log de entregas do webhook (paginado)' })
  async deliveries(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const p = Number(page) || 1;
    const l = Math.min(Number(limit) || 20, 100);
    const { deliveries, total } = await this.service.listDeliveries(id, orgId, p, l);
    return toPublicPage(deliveries.map(mapDelivery), total, p, l);
  }

  @Post(':id/ping')
  @ApiOperation({ summary: 'Envia um evento de teste (PING)' })
  async ping(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.ping(id, orgId);
  }
}
```

- [ ] **Step 2: Register in PublicApiModule**

Em `public-api.module.ts`: adicionar `WebhooksModule` aos imports e `PublicWebhooksController` aos controllers.

```ts
import { WebhooksModule } from '../webhooks/webhooks.module';
import { PublicWebhooksController } from '../webhooks/public-webhooks.controller';
// imports: [ ...existentes, WebhooksModule ]
// controllers: [ ...existentes, PublicWebhooksController ]
```

- [ ] **Step 3: Build + commit**

```bash
yarn build
git add src/modules/webhooks/public-webhooks.controller.ts src/modules/public-api/public-api.module.ts
git commit -m "feat(webhooks): public webhooks controller (API-key)"
```

---

## Task 13: Controller interno (JWT) para o Admin

**Files:**
- Create: `src/modules/webhooks/webhooks.controller.ts`
- Modify: `src/app.module.ts` (garantir que `WebhooksModule` está nos imports do app e que o controller é registrado)

- [ ] **Step 1: Write the internal controller**

```ts
// webhooks.controller.ts
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { mapSubscription } from './mappers/webhook-subscription.mapper';
import { mapDelivery } from './mappers/webhook-delivery.mapper';
import { CreateWebhookPublicDto } from './dto/create-webhook.public.dto';
import { UpdateWebhookPublicDto } from './dto/update-webhook.public.dto';

@ApiTags('Webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Roles(OrgRole.OWNER, OrgRole.ADMIN)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: WebhookSubscriptionsService) {}

  @Get()
  async list(@CurrentOrg('id') orgId: string) {
    const subs = await this.service.findAll(orgId);
    return subs.map((s) => mapSubscription(s));
  }

  @Post()
  @ApiOperation({ summary: 'Cria webhook (retorna secret uma vez)' })
  async create(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string, @Body() dto: CreateWebhookPublicDto) {
    return mapSubscription(await this.service.create(orgId, userId, dto), true);
  }

  @Patch(':id')
  async update(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Body() dto: UpdateWebhookPublicDto) {
    return mapSubscription(await this.service.update(id, orgId, dto));
  }

  @Delete(':id')
  async remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.remove(id, orgId);
  }

  @Get(':id/deliveries')
  async deliveries(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Query('page') page = 1, @Query('limit') limit = 20) {
    const p = Number(page) || 1;
    const l = Math.min(Number(limit) || 20, 100);
    const { deliveries } = await this.service.listDeliveries(id, orgId, p, l);
    return deliveries.map(mapDelivery);
  }

  @Post(':id/ping')
  async ping(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.ping(id, orgId);
  }
}
```

- [ ] **Step 2: Register the controller**

O `WebhooksController` (interno) precisa estar num módulo que o AppModule carrega. Adicionar `WebhooksController` ao array `controllers` do `WebhooksModule` (Task 11) — abrir `webhooks.module.ts` e incluir:

```ts
import { WebhooksController } from './webhooks.controller';
// controllers: [WebhooksController],
```

E garantir que `WebhooksModule` está nos `imports` do `AppModule` (rodar `grep -n "WebhooksModule\|AutomationsModule" src/app.module.ts`; se `AutomationsModule` já o importa, o controller interno ainda precisa que o módulo esteja no grafo — como AutomationsModule importa WebhooksModule, ele já está no grafo, mas controllers só sobem se o módulo estiver na cadeia de imports do AppModule. Adicionar `WebhooksModule` diretamente aos imports do AppModule para garantir).

- [ ] **Step 3: Build + verify routes**

Run: `yarn build && yarn start:dev` (se ambiente permitir) → conferir rotas `/api/v1/webhooks` e `/api/v1/public/webhooks` no log/Swagger.
Expected: ambas registradas.

- [ ] **Step 4: Commit**

```bash
git add src/modules/webhooks/webhooks.controller.ts src/modules/webhooks/webhooks.module.ts src/app.module.ts
git commit -m "feat(webhooks): internal JWT controller for Admin"
```

---

## Task 14: Front — service + página no Admin

**Files:**
- Create: `chat-bullq-web/src/features/settings/services/webhooks.service.ts`
- Create: `chat-bullq-web/src/app/(dashboard)/settings/webhooks/page.tsx`

Trabalhar no repo `chat-bullq-web`, branch nova `feat/public-api-webhooks-admin` (criada a partir do estado atual).

- [ ] **Step 1: Create branch**

```bash
cd chat-bullq-web && git checkout -b feat/public-api-webhooks-admin
```

- [ ] **Step 2: Write the service**

```ts
// webhooks.service.ts
import { api } from '@/lib/api';

export interface WebhookSub {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  secret: string;
  consecutiveFailures: number;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export const WEBHOOK_EVENTS = [
  'MESSAGE_RECEIVED', 'CONVERSATION_CREATED', 'CONVERSATION_STATUS_CHANGED',
  'CONVERSATION_ASSIGNED', 'TAG_ADDED', 'TAG_REMOVED',
] as const;

export const webhooksService = {
  async list(): Promise<WebhookSub[]> {
    const { data } = await api.get('/webhooks');
    return data.data;
  },
  async create(payload: { url: string; events: string[]; description?: string }): Promise<WebhookSub> {
    const { data } = await api.post('/webhooks', payload);
    return data.data;
  },
  async update(id: string, payload: Partial<{ url: string; events: string[]; isActive: boolean; description: string }>): Promise<WebhookSub> {
    const { data } = await api.patch(`/webhooks/${id}`, payload);
    return data.data;
  },
  async remove(id: string): Promise<void> {
    await api.delete(`/webhooks/${id}`);
  },
  async deliveries(id: string): Promise<WebhookDelivery[]> {
    const { data } = await api.get(`/webhooks/${id}/deliveries`);
    return data.data;
  },
  async ping(id: string): Promise<void> {
    await api.post(`/webhooks/${id}/ping`);
  },
};
```

> **Nota:** confirmar que o `api` client (`@/lib/api`) prefixa `/api/v1` e injeta JWT + org header, igual ao `api-keys.service.ts`. O envelope de resposta é `{ data: ... }` (por isso `data.data`).

- [ ] **Step 3: Write the page**

```tsx
// settings/webhooks/page.tsx
'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Webhook, Send, Power } from 'lucide-react';
import { toast } from 'sonner';
import { webhooksService, WEBHOOK_EVENTS, type WebhookSub } from '@/features/settings/services/webhooks.service';

export default function SettingsWebhooksPage() {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const { data: hooks, isLoading } = useQuery({ queryKey: ['webhooks'], queryFn: () => webhooksService.list() });
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks'] });

  const toggleEvent = (e: string) =>
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));

  const handleCreate = async () => {
    if (!url.trim() || events.length === 0) { toast.error('Informe URL e ao menos um evento'); return; }
    setCreating(true);
    try {
      const created = await webhooksService.create({ url: url.trim(), events });
      setCreatedSecret(created.secret);
      setUrl(''); setEvents([]); refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao criar webhook');
    } finally { setCreating(false); }
  };

  const handleRemove = async (h: WebhookSub) => {
    if (!confirm(`Remover o webhook ${h.url}?`)) return;
    try { await webhooksService.remove(h.id); toast.success('Removido'); refresh(); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Erro'); }
  };

  const handlePing = async (h: WebhookSub) => {
    try { await webhooksService.ping(h.id); toast.success('Ping enviado'); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Erro'); }
  };

  const handleToggle = async (h: WebhookSub) => {
    try { await webhooksService.update(h.id, { isActive: !h.isActive }); refresh(); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Erro'); }
  };

  return (
    <div>
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Webhooks</h2>
        <p className="mt-0.5 text-sm text-zinc-500">
          Receba eventos do chat na sua URL. O secret é mostrado uma única vez na criação.
        </p>
      </div>

      <div className="mt-6 space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <input
          value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://seu-sistema.com/webhooks/bullq"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <div className="flex flex-wrap gap-2">
          {WEBHOOK_EVENTS.map((e) => (
            <button key={e} onClick={() => toggleEvent(e)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${events.includes(e) ? 'bg-primary text-primary-foreground' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'}`}>
              {e}
            </button>
          ))}
        </div>
        <button onClick={handleCreate} disabled={creating}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          <Plus className="h-4 w-4" /> {creating ? 'Criando...' : 'Criar webhook'}
        </button>
      </div>

      {createdSecret && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
          <p className="text-xs font-medium">Secret (copie agora — não será exibido novamente):</p>
          <code className="mt-1 block break-all font-mono text-xs">{createdSecret}</code>
        </div>
      )}

      <div className="mt-6 space-y-2">
        {isLoading ? (
          <div className="h-16 animate-pulse rounded-lg border bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900" />
        ) : !hooks?.length ? (
          <div className="flex flex-col items-center py-12 text-center">
            <Webhook className="h-10 w-10 text-zinc-200 dark:text-zinc-700" />
            <p className="mt-3 text-sm text-zinc-500">Nenhum webhook criado</p>
          </div>
        ) : (
          hooks.map((h) => (
            <div key={h.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{h.url}</span>
                  {!h.isActive && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-600 dark:bg-red-900/30">DESATIVADO</span>}
                </div>
                <div className="mt-1 text-xs text-zinc-500">{h.events.join(', ')}</div>
              </div>
              <div className="ml-3 flex items-center gap-1">
                <button onClick={() => handlePing(h)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Enviar ping"><Send className="h-3.5 w-3.5" /></button>
                <button onClick={() => handleToggle(h)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Ativar/desativar"><Power className="h-3.5 w-3.5" /></button>
                <button onClick={() => handleRemove(h)} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20" title="Remover"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

> **Nota p/ implementador:** adicionar o link "Webhooks" na navegação de settings — localizar como as outras abas (`api-keys`, `tags`) são listadas (`grep -rn "api-keys" src/app src/components | grep -i nav` ou o layout de settings) e incluir a entrada seguindo o mesmo padrão.

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit 2>&1 | grep -E "webhooks" || echo "sem erros nos arquivos novos"
git add "src/features/settings/services/webhooks.service.ts" "src/app/(dashboard)/settings/webhooks/page.tsx"
git commit -m "feat(web): webhooks management page in Admin"
```

---

## Task 15: Suíte completa + revisão final

- [ ] **Step 1: Backend — suíte + typecheck + build**

Run: `cd chat-bullq-api && yarn test && yarn typecheck && yarn build`
Expected: tudo verde.

- [ ] **Step 2: Front — typecheck**

Run: `cd chat-bullq-web && npx tsc --noEmit`
Expected: 0 erros nos arquivos novos.

- [ ] **Step 3: Checklist de smoke manual (ambiente com DB+Redis+API-key)**

- `POST /public/webhooks` com `{url, events:["MESSAGE_RECEIVED"]}` → retorna secret.
- Enviar uma mensagem inbound (ou disparar evento) → o endpoint recebe POST assinado; validar `X-BullQ-Signature` recomputando HMAC.
- `POST /public/webhooks/:id/ping` → chega um POST `type:"PING"`.
- Apontar para uma URL que retorna 500 → após 5 tentativas, delivery vira DLQ; após 10 falhas consecutivas, subscription auto-desativa + notificação.
- `GET /public/webhooks/:id/deliveries` → log paginado.
- Admin: página `settings/webhooks` cria/lista/pinga/remove.

- [ ] **Step 4: Commit final (ajustes do smoke, se houver)**

```bash
git add -A && git commit -m "chore(webhooks): finalize after smoke test"
```

---

## Notas de execução

- **Aditivo:** o único arquivo de comportamento existente tocado é `automation-event.processor.ts` (hook não-bloqueante) + `automations.module.ts`/`public-api.module.ts`/`app.module.ts` (só imports/registro). Nada existente muda de comportamento.
- **axios vs @nestjs/axios:** decidir na Task 9 conforme o que já existe no projeto (ver nota). Manter mock do teste alinhado à escolha.
- **Branches:** API em `feat/public-api-phase2-webhooks` (já criada); Web em `feat/public-api-webhooks-admin` (criar na Task 14).
- **Smoke em runtime** depende de Postgres + Redis + API-key — fica pro ambiente do usuário.
- **Edge-case conhecido (baixo impacto):** se o job de automação falhar e o BullMQ reexecutar `process()`, o `dispatch` roda de novo → `webhookDelivery.create` cria uma linha PENDING duplicada, mas o `queue.add` com `jobId = sub:outboxEventId` deduplica a entrega real (só uma vai pro ar). Resultado: no máximo uma linha de log PENDING órfã em caso de retry de automação (raro). Refinamento opcional (não bloqueia a Fase 2): guardar antes do create um `findFirst` por `(subscriptionId, outboxEventId)` e pular se já existe.
```
