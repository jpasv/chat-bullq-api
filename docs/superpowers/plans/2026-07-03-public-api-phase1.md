# Public API — Fase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor a superfície pública de integração (Contacts, Channels, Conversations, Messages) do Chat BullQ via controllers finos + mappers, reusando os serviços internos existentes, e adicionar a página "Desenvolvedores / API" no Admin.

**Architecture:** Controllers `public/*` no `PublicApiModule` chamam serviços internos já testados (`ContactsService`, `ChannelsService`, `ConversationsService`, `MessagesService`). Uma camada de DTOs + mappers define o contrato público estável. Auth por API-key com escopo por org e `access: 'ALL'`. **Aditivo apenas** — nenhum endpoint/serviço existente é modificado; onde um serviço precisa de capacidade nova (ex.: criar contato), o método é **adicionado**.

**Tech Stack:** NestJS 11, Prisma 6, Jest (ts-jest, specs unitários colocados com mocks), Swagger. Front: Next 16 / React 19 / TanStack Query / Tailwind.

---

## Convenções verificadas no código (não re-derivar)

- Prefixo global: `api/v1` → `@Controller('public/x')` vira `api/v1/public/x`.
- Envelope automático `{ data, meta:{timestamp} }` via `ResponseInterceptor` — **não** envelopar manualmente.
- Auth: `@UseGuards(ApiKeyAuthGuard)` + `@ApiSecurity('api-key')`; decorators `@CurrentOrg('id')`, `@CurrentUser('id')`.
- Assinaturas reusadas (exatas):
  - `ContactsService.findAll(orgId, search|undefined, page, limit)` → `{ contacts, pagination:{page,limit,total,totalPages} }`
  - `ContactsService.findOne(id, orgId)` / `update(id, orgId, dto)` / `remove(id, orgId)` → contato cru
  - `ChannelsService.findAll(orgId, 'ALL')` / `findOne(id, orgId, 'ALL')`
  - `ConversationsService.findInbox(orgId, filters, page, limit, 'ALL')`
  - `ConversationsService.findOne(id, orgId, 'ALL')`
  - `ConversationsService.close(id, orgId, actorId, 'ALL')` / `reopen(id, orgId, actorId, 'ALL')`
  - `ConversationsService.update(id, orgId, dto, actorId, 'ALL')` — dto `{ assignedToId?, departmentId?, status?, subject? }`
  - `MessagesService.send(dto, senderId, orgId, 'ALL')` — dto `{ conversationId, type, content, replyToMessageId?, replyTo? }`
  - `MessagesService.findByConversation(convId, orgId, page, limit, 'ALL')`
- Test pattern: `*.spec.ts` colocado; instanciar a classe com deps mockadas (ver `conversations.repository.spec.ts`). Rodar: `yarn test <caminho>`.
- Contact model: `{ id, name?, phone?, email?, avatarUrl?, notes?, metadata, createdAt, updatedAt }`; relações `channels[{channel:{id,type,name}, externalId, profileName}]`, `tags[{tag}]`, `_count.conversations`.
- ContactChannel unique: `uq_contact_channel_external([channelId, externalId])`.

---

## Estrutura de arquivos (backend)

```
src/modules/public-api/
  public-api.module.ts                 # MODIFICAR: + imports/controllers/guard
  dto/
    public-page.ts                     # CRIAR: tipo de página + helper toPublicPage
    create-contact.public.dto.ts       # CRIAR
    update-contact.public.dto.ts       # CRIAR
    list-conversations.public.dto.ts   # CRIAR
    assign-conversation.public.dto.ts  # CRIAR
    send-message.public.dto.ts         # CRIAR
  mappers/
    contact.mapper.ts                  # CRIAR (+ .spec.ts)
    channel.mapper.ts                  # CRIAR (+ .spec.ts)
    conversation.mapper.ts             # CRIAR (+ .spec.ts)
    message.mapper.ts                  # CRIAR (+ .spec.ts)
  guards/
    api-key-throttle.guard.ts          # CRIAR (+ .spec.ts)
  controllers/
    public-contacts.controller.ts      # CRIAR
    public-channels.controller.ts      # CRIAR
    public-conversations.controller.ts # CRIAR
    public-messages.controller.ts      # CRIAR

src/modules/messaging/contacts/
  contacts.service.ts                  # MODIFICAR: + método create (aditivo)
  contacts.repository.ts               # MODIFICAR: + método createWithChannel (aditivo) (+ .spec.ts)

src/main.ts                            # MODIFICAR: + Swagger /docs/public
```

## Estrutura de arquivos (frontend)

```
chat-bullq-web/src/features/settings/components/
  api-reference.tsx                    # CRIAR: seção de referência da API pública
chat-bullq-web/src/features/settings/data/
  public-api-endpoints.ts              # CRIAR: constante estática de endpoints
chat-bullq-web/src/app/(dashboard)/settings/api-keys/page.tsx  # MODIFICAR: render <ApiReference/>
```

---

## Task 1: Helper de paginação pública

**Files:**
- Create: `src/modules/public-api/dto/public-page.ts`
- Test: `src/modules/public-api/dto/public-page.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/public-api/dto/public-page.spec.ts
import { toPublicPage } from './public-page';

describe('toPublicPage', () => {
  it('monta a página pública com hasMore=true quando há mais itens', () => {
    const res = toPublicPage([{ id: 'a' }, { id: 'b' }], 10, 1, 2);
    expect(res).toEqual({ items: [{ id: 'a' }, { id: 'b' }], page: 1, limit: 2, total: 10, hasMore: true });
  });

  it('hasMore=false na última página', () => {
    const res = toPublicPage([{ id: 'a' }], 3, 2, 2);
    expect(res.hasMore).toBe(false);
  });

  it('hasMore=false quando total=0', () => {
    expect(toPublicPage([], 0, 1, 20).hasMore).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/public-api/dto/public-page.spec.ts`
Expected: FAIL — "Cannot find module './public-page'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/public-api/dto/public-page.ts
export interface PublicPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export function toPublicPage<T>(items: T[], total: number, page: number, limit: number): PublicPage<T> {
  return { items, page, limit, total, hasMore: page * limit < total };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/public-api/dto/public-page.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/public-api/dto/public-page.ts src/modules/public-api/dto/public-page.spec.ts
git commit -m "feat(public-api): add public pagination helper"
```

---

## Task 2: Contact mapper

**Files:**
- Create: `src/modules/public-api/mappers/contact.mapper.ts`
- Test: `src/modules/public-api/mappers/contact.mapper.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/public-api/mappers/contact.mapper.spec.ts
import { mapContact } from './contact.mapper';

describe('mapContact', () => {
  const raw = {
    id: 'c1', organizationId: 'org1', name: 'Ana', phone: '5511999', email: null,
    avatarUrl: 'http://x/a.png', notes: 'vip', metadata: { foo: 1 },
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'), deletedAt: null,
    channels: [{ externalId: '5511999', profileName: 'Ana W', channel: { id: 'ch1', type: 'WHATSAPP_CLOUD', name: 'Vendas' } }],
    tags: [{ tag: { id: 't1', name: 'Lead', color: '#f00' } }],
    _count: { conversations: 4 },
  };

  it('expõe apenas campos públicos e omite internos (organizationId, deletedAt)', () => {
    const out = mapContact(raw as any);
    expect(out).toMatchObject({
      id: 'c1', name: 'Ana', phone: '5511999', email: null, avatarUrl: 'http://x/a.png',
      notes: 'vip', metadata: { foo: 1 }, conversationsCount: 4,
    });
    expect((out as any).organizationId).toBeUndefined();
    expect((out as any).deletedAt).toBeUndefined();
  });

  it('mapeia canais e tags para shape público', () => {
    const out = mapContact(raw as any);
    expect(out.channels).toEqual([{ id: 'ch1', type: 'WHATSAPP_CLOUD', name: 'Vendas', externalId: '5511999', profileName: 'Ana W' }]);
    expect(out.tags).toEqual([{ id: 't1', name: 'Lead', color: '#f00' }]);
  });

  it('tolera contato sem channels/tags/_count', () => {
    const out = mapContact({ id: 'c2', createdAt: new Date(), updatedAt: new Date() } as any);
    expect(out.channels).toEqual([]);
    expect(out.tags).toEqual([]);
    expect(out.conversationsCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/public-api/mappers/contact.mapper.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/public-api/mappers/contact.mapper.ts
export interface PublicContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  avatarUrl: string | null;
  notes: string | null;
  metadata: unknown;
  channels: { id: string; type: string; name: string; externalId: string; profileName: string | null }[];
  tags: { id: string; name: string; color: string | null }[];
  conversationsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function mapContact(c: any): PublicContact {
  return {
    id: c.id,
    name: c.name ?? null,
    phone: c.phone ?? null,
    email: c.email ?? null,
    avatarUrl: c.avatarUrl ?? null,
    notes: c.notes ?? null,
    metadata: c.metadata ?? {},
    channels: (c.channels ?? []).map((cc: any) => ({
      id: cc.channel?.id,
      type: cc.channel?.type,
      name: cc.channel?.name,
      externalId: cc.externalId,
      profileName: cc.profileName ?? null,
    })),
    tags: (c.tags ?? []).map((t: any) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color ?? null })),
    conversationsCount: c._count?.conversations ?? 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/public-api/mappers/contact.mapper.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/public-api/mappers/contact.mapper.ts src/modules/public-api/mappers/contact.mapper.spec.ts
git commit -m "feat(public-api): add contact mapper"
```

---

## Task 3: Channel mapper

**Files:**
- Create: `src/modules/public-api/mappers/channel.mapper.ts`
- Test: `src/modules/public-api/mappers/channel.mapper.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/public-api/mappers/channel.mapper.spec.ts
import { mapChannel } from './channel.mapper';

describe('mapChannel', () => {
  it('expõe campos públicos e omite segredos (accessToken, webhookSecret, config)', () => {
    const out = mapChannel({
      id: 'ch1', name: 'Vendas', type: 'WHATSAPP_CLOUD', status: 'ACTIVE',
      phoneNumber: '5511999', createdAt: new Date('2026-01-01'),
      accessToken: 'SECRET', webhookSecret: 'SECRET2', config: { token: 'x' },
    } as any);
    expect(out).toEqual({ id: 'ch1', name: 'Vendas', type: 'WHATSAPP_CLOUD', status: 'ACTIVE', phoneNumber: '5511999', createdAt: new Date('2026-01-01') });
    expect((out as any).accessToken).toBeUndefined();
    expect((out as any).webhookSecret).toBeUndefined();
    expect((out as any).config).toBeUndefined();
  });
});
```

> **Nota p/ implementador:** confirmar quais campos sensíveis o model `Channel` tem (rodar `awk '/^model Channel \{/,/^\}/' prisma/schema.prisma`) e garantir que o mapper faça **allowlist** (só copia campos públicos), nunca blocklist.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/public-api/mappers/channel.mapper.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/public-api/mappers/channel.mapper.ts
export interface PublicChannel {
  id: string;
  name: string;
  type: string;
  status: string | null;
  phoneNumber: string | null;
  createdAt: Date;
}

// Allowlist: só campos abaixo saem. Qualquer segredo do model é ignorado por construção.
export function mapChannel(ch: any): PublicChannel {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    status: ch.status ?? null,
    phoneNumber: ch.phoneNumber ?? null,
    createdAt: ch.createdAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/public-api/mappers/channel.mapper.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/public-api/mappers/channel.mapper.ts src/modules/public-api/mappers/channel.mapper.spec.ts
git commit -m "feat(public-api): add channel mapper (allowlist, no secrets)"
```

---

## Task 4: Conversation mapper

**Files:**
- Create: `src/modules/public-api/mappers/conversation.mapper.ts`
- Test: `src/modules/public-api/mappers/conversation.mapper.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/public-api/mappers/conversation.mapper.spec.ts
import { mapConversation } from './conversation.mapper';

describe('mapConversation', () => {
  const raw = {
    id: 'cv1', status: 'OPEN', channelId: 'ch1', contactId: 'c1', assignedToId: 'u1',
    departmentId: 'd1', unreadCount: 2, lastMessageAt: new Date('2026-02-01'),
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-02-01'),
    channel: { id: 'ch1', type: 'WHATSAPP_CLOUD', name: 'Vendas' },
    contact: { id: 'c1', name: 'Ana', phone: '5511999' },
  };

  it('expõe campos públicos e resumo de canal/contato', () => {
    const out = mapConversation(raw as any);
    expect(out).toMatchObject({
      id: 'cv1', status: 'OPEN', assignedToId: 'u1', departmentId: 'd1',
      unreadCount: 2, channelId: 'ch1', contactId: 'c1',
    });
    expect(out.channel).toEqual({ id: 'ch1', type: 'WHATSAPP_CLOUD', name: 'Vendas' });
    expect(out.contact).toEqual({ id: 'c1', name: 'Ana', phone: '5511999' });
  });

  it('tolera conversa sem channel/contact carregados', () => {
    const out = mapConversation({ id: 'cv2', status: 'CLOSED', createdAt: new Date(), updatedAt: new Date() } as any);
    expect(out.channel).toBeNull();
    expect(out.contact).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/public-api/mappers/conversation.mapper.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/public-api/mappers/conversation.mapper.ts
export interface PublicConversation {
  id: string;
  status: string;
  channelId: string | null;
  contactId: string | null;
  assignedToId: string | null;
  departmentId: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  channel: { id: string; type: string; name: string } | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

export function mapConversation(cv: any): PublicConversation {
  return {
    id: cv.id,
    status: cv.status,
    channelId: cv.channelId ?? null,
    contactId: cv.contactId ?? null,
    assignedToId: cv.assignedToId ?? null,
    departmentId: cv.departmentId ?? null,
    unreadCount: cv.unreadCount ?? 0,
    lastMessageAt: cv.lastMessageAt ?? null,
    createdAt: cv.createdAt,
    updatedAt: cv.updatedAt,
    channel: cv.channel ? { id: cv.channel.id, type: cv.channel.type, name: cv.channel.name } : null,
    contact: cv.contact ? { id: cv.contact.id, name: cv.contact.name ?? null, phone: cv.contact.phone ?? null } : null,
  };
}
```

> **Nota p/ implementador:** conferir os nomes reais no model `Conversation` (`awk '/^model Conversation \{/,/^\}/' prisma/schema.prisma`) — especialmente `unreadCount`/`lastMessageAt`. Ajustar o mapper se o nome divergir; o `.spec.ts` documenta o contrato público desejado.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/public-api/mappers/conversation.mapper.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/public-api/mappers/conversation.mapper.ts src/modules/public-api/mappers/conversation.mapper.spec.ts
git commit -m "feat(public-api): add conversation mapper"
```

---

## Task 5: Message mapper

**Files:**
- Create: `src/modules/public-api/mappers/message.mapper.ts`
- Test: `src/modules/public-api/mappers/message.mapper.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/public-api/mappers/message.mapper.spec.ts
import { mapMessage } from './message.mapper';

describe('mapMessage', () => {
  const raw = {
    id: 'm1', conversationId: 'cv1', direction: 'OUTBOUND', type: 'TEXT',
    content: { text: 'oi' }, status: 'SENT', externalId: 'wamid.x', senderId: 'u1',
    createdAt: new Date('2026-03-01'),
  };

  it('expõe campos públicos da mensagem', () => {
    const out = mapMessage(raw as any);
    expect(out).toEqual({
      id: 'm1', conversationId: 'cv1', direction: 'OUTBOUND', type: 'TEXT',
      content: { text: 'oi' }, status: 'SENT', externalId: 'wamid.x', senderId: 'u1',
      createdAt: new Date('2026-03-01'),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/public-api/mappers/message.mapper.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/public-api/mappers/message.mapper.ts
export interface PublicMessage {
  id: string;
  conversationId: string;
  direction: string;
  type: string;
  content: unknown;
  status: string | null;
  externalId: string | null;
  senderId: string | null;
  createdAt: Date;
}

export function mapMessage(m: any): PublicMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    content: m.content ?? null,
    status: m.status ?? null,
    externalId: m.externalId ?? null,
    senderId: m.senderId ?? null,
    createdAt: m.createdAt,
  };
}
```

> **Nota p/ implementador:** conferir nomes no model `Message` (`awk '/^model Message \{/,/^\}/' prisma/schema.prisma`). Ajustar mapper + spec se algum campo divergir.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/public-api/mappers/message.mapper.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/public-api/mappers/message.mapper.ts src/modules/public-api/mappers/message.mapper.spec.ts
git commit -m "feat(public-api): add message mapper"
```

---

## Task 6: Rate-limit guard por API-key

**Files:**
- Create: `src/modules/public-api/guards/api-key-throttle.guard.ts`
- Test: `src/modules/public-api/guards/api-key-throttle.guard.spec.ts`

Espelha o `WebhookThrottleGuard` (sliding window in-memory) mas keyed pela API-key. A key é identificada por `req.apiKeyId` se a estratégia expuser, senão pelo header `authorization` (fallback). Limite: 100 hits / 5s.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/public-api/guards/api-key-throttle.guard.spec.ts
import { ApiKeyThrottleGuard } from './api-key-throttle.guard';
import { ExecutionContext } from '@nestjs/common';

function ctx(key: string): ExecutionContext {
  const req = { apiKeyId: key, headers: { authorization: `Bearer ${key}` } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('ApiKeyThrottleGuard', () => {
  it('permite requisições abaixo do limite', () => {
    const guard = new ApiKeyThrottleGuard();
    for (let i = 0; i < 100; i++) expect(guard.canActivate(ctx('k1'))).toBe(true);
  });

  it('bloqueia (429) ao exceder o limite na mesma janela', () => {
    const guard = new ApiKeyThrottleGuard();
    for (let i = 0; i < 100; i++) guard.canActivate(ctx('k2'));
    expect(() => guard.canActivate(ctx('k2'))).toThrow(/Too Many Requests|429|rate/i);
  });

  it('isola contadores por key', () => {
    const guard = new ApiKeyThrottleGuard();
    for (let i = 0; i < 100; i++) guard.canActivate(ctx('kA'));
    expect(guard.canActivate(ctx('kB'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/public-api/guards/api-key-throttle.guard.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/public-api/guards/api-key-throttle.guard.ts
import { CanActivate, ExecutionContext, Injectable, HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class ApiKeyThrottleGuard implements CanActivate {
  private static readonly WINDOW_MS = 5_000;
  private static readonly MAX_HITS = 100;
  private readonly hits = new Map<string, number[]>();
  private lastGc = 0;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { apiKeyId?: string }>();
    const key = req.apiKeyId || String(req.headers?.authorization || 'anon');

    const now = Date.now();
    const windowStart = now - ApiKeyThrottleGuard.WINDOW_MS;
    const recent = (this.hits.get(key) || []).filter((t) => t >= windowStart);
    recent.push(now);
    this.hits.set(key, recent);

    if (now - this.lastGc > 30_000) {
      this.lastGc = now;
      for (const [k, arr] of this.hits.entries()) {
        const live = arr.filter((t) => t >= windowStart);
        if (live.length) this.hits.set(k, live);
        else this.hits.delete(k);
      }
    }

    if (recent.length > ApiKeyThrottleGuard.MAX_HITS) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
```

> **Nota p/ implementador:** verificar se a estratégia Passport `api-key` já anexa um id da chave em `req` (rodar `grep -rn "apiKey" src/modules/auth/`). Se anexar (ex.: `req.user.apiKeyId` ou `req.apiKey.id`), preferir esse campo em vez do header — ajuste a linha `const key = ...` e o mock do teste juntos.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/public-api/guards/api-key-throttle.guard.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/public-api/guards/api-key-throttle.guard.ts src/modules/public-api/guards/api-key-throttle.guard.spec.ts
git commit -m "feat(public-api): add per-key rate-limit guard"
```

---

## Task 7: Criar contato — método aditivo no repo + service

**Files:**
- Modify: `src/modules/messaging/contacts/contacts.repository.ts` (adicionar `createWithChannel`)
- Modify: `src/modules/messaging/contacts/contacts.service.ts` (adicionar `create`)
- Test: `src/modules/messaging/contacts/contacts.service.spec.ts`

Aditivo: cria `Contact` e, se `channelId` vier, faz upsert de `ContactChannel` com `externalId = phone` (idempotente pela unique `uq_contact_channel_external`). Não altera métodos existentes.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/messaging/contacts/contacts.service.spec.ts
import { ContactsService } from './contacts.service';

describe('ContactsService.create (aditivo)', () => {
  const build = () => {
    const repo = {
      createWithChannel: jest.fn().mockResolvedValue({ id: 'c1', name: 'Ana', phone: '5511999' }),
      findByChannelExternal: jest.fn().mockResolvedValue(null),
    };
    return { repo, service: new ContactsService(repo as any) };
  };

  it('cria contato novo com canal', async () => {
    const { repo, service } = build();
    const out = await service.create('org1', { name: 'Ana', phone: '5511999', channelId: 'ch1' });
    expect(repo.createWithChannel).toHaveBeenCalledWith('org1', { name: 'Ana', phone: '5511999', channelId: 'ch1' });
    expect(out).toMatchObject({ id: 'c1' });
  });

  it('é idempotente: se já existe contactChannel (channel, phone), retorna o existente', async () => {
    const { repo, service } = build();
    repo.findByChannelExternal.mockResolvedValue({ contact: { id: 'existing', name: 'Ana' } });
    const out = await service.create('org1', { name: 'Ana', phone: '5511999', channelId: 'ch1' });
    expect(repo.createWithChannel).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'existing' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/messaging/contacts/contacts.service.spec.ts`
Expected: FAIL — `service.create is not a function` / `repo.createWithChannel` undefined.

- [ ] **Step 3a: Add repository method (aditivo)**

Adicionar ao final da classe em `contacts.repository.ts` (não alterar métodos existentes):

```ts
  async findByChannelExternal(channelId: string, externalId: string) {
    return this.prisma.contactChannel.findUnique({
      where: { uq_contact_channel_external: { channelId, externalId } },
      include: { contact: true },
    });
  }

  async createWithChannel(
    organizationId: string,
    input: { name?: string; phone: string; email?: string; channelId?: string },
  ) {
    return this.prisma.contact.create({
      data: {
        organizationId,
        name: input.name ?? null,
        phone: input.phone,
        email: input.email ?? null,
        channels: input.channelId
          ? { create: { channelId: input.channelId, externalId: input.phone, profileName: input.name ?? null } }
          : undefined,
      },
      include: {
        channels: { include: { channel: { select: { id: true, type: true, name: true } } } },
        tags: { include: { tag: true } },
        _count: { select: { conversations: true } },
      },
    });
  }
```

- [ ] **Step 3b: Add service method (aditivo)**

Adicionar ao final da classe em `contacts.service.ts`:

```ts
  async create(
    organizationId: string,
    input: { name?: string; phone: string; email?: string; channelId?: string },
  ) {
    if (input.channelId) {
      const existing = await this.repository.findByChannelExternal(input.channelId, input.phone);
      if (existing) return existing.contact;
    }
    return this.repository.createWithChannel(organizationId, input);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/messaging/contacts/contacts.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
yarn typecheck
git add src/modules/messaging/contacts/contacts.repository.ts src/modules/messaging/contacts/contacts.service.ts src/modules/messaging/contacts/contacts.service.spec.ts
git commit -m "feat(contacts): add additive create method for public API"
```

---

## Task 8: DTOs públicos de request

**Files:**
- Create: `src/modules/public-api/dto/create-contact.public.dto.ts`
- Create: `src/modules/public-api/dto/update-contact.public.dto.ts`
- Create: `src/modules/public-api/dto/list-conversations.public.dto.ts`
- Create: `src/modules/public-api/dto/assign-conversation.public.dto.ts`
- Create: `src/modules/public-api/dto/send-message.public.dto.ts`

- [ ] **Step 1: Write the DTOs**

```ts
// create-contact.public.dto.ts
import { IsString, IsOptional, IsEmail } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateContactPublicDto {
  @ApiProperty({ example: '5511999998888', description: 'Telefone E.164 (só dígitos)' })
  @IsString()
  phone: string;

  @ApiPropertyOptional({ example: 'Ana Silva' })
  @IsOptional() @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'ana@x.com' })
  @IsOptional() @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Vincula o contato a este canal (externalId = phone)' })
  @IsOptional() @IsString()
  channelId?: string;
}
```

```ts
// update-contact.public.dto.ts
import { IsString, IsOptional, IsEmail } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateContactPublicDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
```

```ts
// list-conversations.public.dto.ts
import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListConversationsPublicDto {
  @ApiPropertyOptional({ description: 'CSV de status: OPEN,PENDING,CLOSED...' })
  @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() channelId?: string;
  @ApiPropertyOptional({ description: 'CSV de tag ids' }) @IsOptional() @IsString() tagIds?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
```

```ts
// assign-conversation.public.dto.ts
import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AssignConversationPublicDto {
  @ApiPropertyOptional({ description: 'Id do usuário responsável' })
  @IsOptional() @IsString() assignedToId?: string;
  @ApiPropertyOptional({ description: 'Id do setor/departamento' })
  @IsOptional() @IsString() departmentId?: string;
}
```

```ts
// send-message.public.dto.ts
import { IsString, IsObject, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessagePublicDto {
  @ApiProperty({ example: 'conversation-id' })
  @IsString() conversationId: string;

  @ApiProperty({ enum: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'] })
  @IsEnum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT']) type: string;

  @ApiProperty({ example: { text: 'Olá!' } })
  @IsObject() content: Record<string, any>;

  @ApiPropertyOptional({ description: 'Id interno da Message respondida' })
  @IsOptional() @IsString() replyToMessageId?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `yarn typecheck`
Expected: sem erros novos.

- [ ] **Step 3: Commit**

```bash
git add src/modules/public-api/dto/
git commit -m "feat(public-api): add request DTOs"
```

---

## Task 9: Controller de Contacts

**Files:**
- Create: `src/modules/public-api/controllers/public-contacts.controller.ts`

- [ ] **Step 1: Write the controller**

```ts
// public-contacts.controller.ts
import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { ApiKeyThrottleGuard } from '../guards/api-key-throttle.guard';
import { ContactsService } from '../../messaging/contacts/contacts.service';
import { mapContact } from '../mappers/contact.mapper';
import { toPublicPage } from '../dto/public-page';
import { CreateContactPublicDto } from '../dto/create-contact.public.dto';
import { UpdateContactPublicDto } from '../dto/update-contact.public.dto';

@ApiTags('Public API · Contacts')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/contacts')
export class PublicContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista contatos (paginado)' })
  async list(
    @CurrentOrg('id') orgId: string,
    @Query('search') search?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const p = Number(page) || 1;
    const l = Math.min(Number(limit) || 20, 100);
    const { contacts, pagination } = await this.contacts.findAll(orgId, search, p, l);
    return toPublicPage(contacts.map(mapContact), pagination.total, p, l);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um contato' })
  async get(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return mapContact(await this.contacts.findOne(id, orgId));
  }

  @Post()
  @ApiOperation({ summary: 'Cria (ou resolve) um contato — idempotente por (canal, telefone)' })
  async create(@CurrentOrg('id') orgId: string, @Body() dto: CreateContactPublicDto) {
    return mapContact(await this.contacts.create(orgId, dto));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um contato' })
  async update(@CurrentOrg('id') orgId: string, @Param('id') id: string, @Body() dto: UpdateContactPublicDto) {
    return mapContact(await this.contacts.update(id, orgId, dto as any));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove (soft-delete) um contato' })
  async remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    await this.contacts.remove(id, orgId);
    return { deleted: true };
  }
}
```

> **Nota:** `mapContact` no `create`/`update` tolera contato sem `_count`/relações (ver Task 2, step 1, 3º teste), então funciona mesmo que `createWithChannel`/`update` retornem shape parcial.

- [ ] **Step 2: Typecheck**

Run: `yarn typecheck`
Expected: sem erros (o wire-up do módulo é na Task 13; typecheck do arquivo isolado passa pois imports resolvem).

- [ ] **Step 3: Commit**

```bash
git add src/modules/public-api/controllers/public-contacts.controller.ts
git commit -m "feat(public-api): add contacts controller"
```

---

## Task 10: Controller de Channels

**Files:**
- Create: `src/modules/public-api/controllers/public-channels.controller.ts`

- [ ] **Step 1: Write the controller**

```ts
// public-channels.controller.ts
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { ApiKeyThrottleGuard } from '../guards/api-key-throttle.guard';
import { ChannelsService } from '../../channel-hub/channels/channels.service';
import { mapChannel } from '../mappers/channel.mapper';

@ApiTags('Public API · Channels')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/channels')
export class PublicChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista canais da organização' })
  async list(@CurrentOrg('id') orgId: string) {
    const channels = await this.channels.findAll(orgId, 'ALL');
    return { items: channels.map(mapChannel) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um canal' })
  async get(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return mapChannel(await this.channels.findOne(id, orgId, 'ALL'));
  }
}
```

> **Nota p/ implementador:** confirmar o retorno de `ChannelsService.findAll` (é array direto ou `{ channels }`?). Ajustar `.map(mapChannel)` conforme — rodar `sed -n '179,195p' src/modules/channel-hub/channels/channels.service.ts`.

- [ ] **Step 2: Typecheck + commit**

```bash
yarn typecheck
git add src/modules/public-api/controllers/public-channels.controller.ts
git commit -m "feat(public-api): add channels controller"
```

---

## Task 11: Controller de Conversations

**Files:**
- Create: `src/modules/public-api/controllers/public-conversations.controller.ts`

- [ ] **Step 1: Write the controller**

```ts
// public-conversations.controller.ts
import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg, CurrentUser } from '../../../common/decorators';
import { ApiKeyThrottleGuard } from '../guards/api-key-throttle.guard';
import { ConversationsService } from '../../messaging/conversations/conversations.service';
import { MessagesService } from '../../messaging/messages/messages.service';
import { mapConversation } from '../mappers/conversation.mapper';
import { mapMessage } from '../mappers/message.mapper';
import { toPublicPage } from '../dto/public-page';
import { ListConversationsPublicDto } from '../dto/list-conversations.public.dto';
import { AssignConversationPublicDto } from '../dto/assign-conversation.public.dto';

@ApiTags('Public API · Conversations')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/conversations')
export class PublicConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista conversas (paginado, filtros por status/canal/tag/busca)' })
  async list(@CurrentOrg('id') orgId: string, @Query() q: ListConversationsPublicDto) {
    const filters = {
      status: q.status,
      channelId: q.channelId,
      tagIds: q.tagIds?.split(',').map((t) => t.trim()).filter(Boolean),
      search: q.search,
    };
    const result: any = await this.conversations.findInbox(orgId, filters, q.page, q.limit, 'ALL');
    const items = (result.conversations ?? result.items ?? result).map(mapConversation);
    const total = result.pagination?.total ?? result.total ?? items.length;
    return toPublicPage(items, total, q.page, q.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma conversa' })
  async get(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return mapConversation(await this.conversations.findOne(id, orgId, 'ALL'));
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Lista mensagens da conversa (paginado)' })
  async messagesOf(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const p = Number(page) || 1;
    const l = Math.min(Number(limit) || 20, 100);
    const result: any = await this.messages.findByConversation(id, orgId, p, l, 'ALL');
    const items = (result.messages ?? result.items ?? result).map(mapMessage);
    const total = result.pagination?.total ?? result.total ?? items.length;
    return toPublicPage(items, total, p, l);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Fecha a conversa' })
  async close(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string, @Param('id') id: string) {
    return mapConversation(await this.conversations.close(id, orgId, userId, 'ALL'));
  }

  @Post(':id/reopen')
  @ApiOperation({ summary: 'Reabre a conversa' })
  async reopen(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string, @Param('id') id: string) {
    return mapConversation(await this.conversations.reopen(id, orgId, userId, 'ALL'));
  }

  @Post(':id/assign')
  @ApiOperation({ summary: 'Transfere a conversa (usuário e/ou setor)' })
  async assign(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AssignConversationPublicDto,
  ) {
    return mapConversation(await this.conversations.update(id, orgId, dto as any, userId, 'ALL'));
  }
}
```

> **Nota p/ implementador:** os shapes de retorno de `findInbox`/`findByConversation` são normalizados defensivamente (`result.conversations ?? result.items ?? result`). Depois de wire-up (Task 13), rodar o endpoint uma vez e fixar o shape real, removendo os fallbacks que não se aplicam.

- [ ] **Step 2: Typecheck + commit**

```bash
yarn typecheck
git add src/modules/public-api/controllers/public-conversations.controller.ts
git commit -m "feat(public-api): add conversations controller"
```

---

## Task 12: Controller de Messages

**Files:**
- Create: `src/modules/public-api/controllers/public-messages.controller.ts`

- [ ] **Step 1: Write the controller**

```ts
// public-messages.controller.ts
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg, CurrentUser } from '../../../common/decorators';
import { ApiKeyThrottleGuard } from '../guards/api-key-throttle.guard';
import { MessagesService } from '../../messaging/messages/messages.service';
import { mapMessage } from '../mappers/message.mapper';
import { SendMessagePublicDto } from '../dto/send-message.public.dto';

@ApiTags('Public API · Messages')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/messages')
export class PublicMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @ApiOperation({ summary: 'Envia uma mensagem numa conversa existente' })
  async send(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SendMessagePublicDto,
  ) {
    const sent = await this.messages.send(dto as any, userId, orgId, 'ALL');
    return mapMessage(sent);
  }
}
```

> **Nota p/ implementador:** confirmar o que `MessagesService.send` retorna (a Message criada?). Se retornar wrapper, ajustar `mapMessage(sent.message ?? sent)`.

- [ ] **Step 2: Typecheck + commit**

```bash
yarn typecheck
git add src/modules/public-api/controllers/public-messages.controller.ts
git commit -m "feat(public-api): add messages controller"
```

---

## Task 13: Wire-up do PublicApiModule

**Files:**
- Modify: `src/modules/public-api/public-api.module.ts`

Verificar antes: `MessagingModule` exporta `ContactsService, ConversationsService, MessagesService` (confirmado). Confirmar que `ChannelHubModule` exporta `ChannelsService` — rodar `grep -n "exports" src/modules/channel-hub/channel-hub.module.ts`; se não exportar, **adicionar** `ChannelsService` ao array `exports` (aditivo).

- [ ] **Step 1: Update the module**

```ts
// public-api.module.ts
import { Module } from '@nestjs/common';
import { PublicMeController } from './controllers/public-me.controller';
import { PublicDashboardController } from './controllers/public-dashboard.controller';
import { PublicContactsController } from './controllers/public-contacts.controller';
import { PublicChannelsController } from './controllers/public-channels.controller';
import { PublicConversationsController } from './controllers/public-conversations.controller';
import { PublicMessagesController } from './controllers/public-messages.controller';
import { ApiKeyThrottleGuard } from './guards/api-key-throttle.guard';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AuthModule } from '../auth/auth.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ChannelHubModule } from '../channel-hub/channel-hub.module';

@Module({
  imports: [AuthModule, DashboardModule, MessagingModule, ChannelHubModule],
  controllers: [
    PublicMeController,
    PublicDashboardController,
    PublicContactsController,
    PublicChannelsController,
    PublicConversationsController,
    PublicMessagesController,
  ],
  providers: [ApiKeyThrottleGuard],
})
export class PublicApiModule {}
```

- [ ] **Step 2: Build to verify DI resolves**

Run: `yarn build`
Expected: build sucesso. Se DI falhar por provider não exportado, adicionar o service faltante ao `exports` do módulo dono (aditivo) e rebuildar.

- [ ] **Step 3: Smoke test manual**

Run: `yarn start:dev` e em outro terminal:
```bash
curl -s -H "Authorization: Bearer <PK_KEY>" http://localhost:3001/api/v1/public/contacts | head
```
Expected: `{ "data": { "items": [...], "page":1, ... }, "meta": {...} }`. 401 se key inválida.

- [ ] **Step 4: Commit**

```bash
git add src/modules/public-api/public-api.module.ts src/modules/channel-hub/channel-hub.module.ts
git commit -m "feat(public-api): wire up phase-1 controllers and rate-limit guard"
```

---

## Task 14: Swagger dedicado /docs/public

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add the second Swagger doc**

Depois do bloco Swagger existente (que monta `/docs`), adicionar:

```ts
  const publicSwagger = new DocumentBuilder()
    .setTitle('Chat BullQ — Public API')
    .setDescription('API pública de integração (contatos, canais, conversas, mensagens). Autentique com Authorization: Bearer <API_KEY>.')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', name: 'Authorization', in: 'header' }, 'api-key')
    .build();
  const publicDoc = SwaggerModule.createDocument(app, publicSwagger, {
    include: [PublicApiModule],
  });
  SwaggerModule.setup('docs/public', app, publicDoc);
```

Adicionar o import no topo: `import { PublicApiModule } from './modules/public-api/public-api.module';`

- [ ] **Step 2: Verify**

Run: `yarn start:dev`, abrir `http://localhost:3001/docs/public`.
Expected: só os endpoints `Public API · *` aparecem; `/docs` (interno) segue completo.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(public-api): dedicated /docs/public OpenAPI"
```

---

## Task 15: Front — dados dos endpoints (Admin)

**Files:**
- Create: `chat-bullq-web/src/features/settings/data/public-api-endpoints.ts`

- [ ] **Step 1: Write the endpoints constant**

```ts
// public-api-endpoints.ts
export interface PublicEndpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  curl: string;
}

const BASE = '/api/v1/public';

export const PUBLIC_API_ENDPOINTS: { group: string; endpoints: PublicEndpoint[] }[] = [
  {
    group: 'Contatos',
    endpoints: [
      { method: 'GET', path: `${BASE}/contacts`, summary: 'Lista contatos', curl: `curl -H "Authorization: Bearer $KEY" "$BASE/contacts?search=ana&page=1&limit=20"` },
      { method: 'POST', path: `${BASE}/contacts`, summary: 'Cria/resolve contato', curl: `curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"phone":"5511999998888","name":"Ana","channelId":"<id>"}' "$BASE/contacts"` },
      { method: 'PATCH', path: `${BASE}/contacts/:id`, summary: 'Atualiza contato', curl: `curl -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"name":"Ana S."}' "$BASE/contacts/<id>"` },
      { method: 'DELETE', path: `${BASE}/contacts/:id`, summary: 'Remove contato', curl: `curl -X DELETE -H "Authorization: Bearer $KEY" "$BASE/contacts/<id>"` },
    ],
  },
  {
    group: 'Canais',
    endpoints: [
      { method: 'GET', path: `${BASE}/channels`, summary: 'Lista canais', curl: `curl -H "Authorization: Bearer $KEY" "$BASE/channels"` },
    ],
  },
  {
    group: 'Conversas',
    endpoints: [
      { method: 'GET', path: `${BASE}/conversations`, summary: 'Lista conversas', curl: `curl -H "Authorization: Bearer $KEY" "$BASE/conversations?status=OPEN"` },
      { method: 'GET', path: `${BASE}/conversations/:id/messages`, summary: 'Mensagens da conversa', curl: `curl -H "Authorization: Bearer $KEY" "$BASE/conversations/<id>/messages"` },
      { method: 'POST', path: `${BASE}/conversations/:id/close`, summary: 'Fecha conversa', curl: `curl -X POST -H "Authorization: Bearer $KEY" "$BASE/conversations/<id>/close"` },
      { method: 'POST', path: `${BASE}/conversations/:id/assign`, summary: 'Transfere conversa', curl: `curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"assignedToId":"<userId>"}' "$BASE/conversations/<id>/assign"` },
    ],
  },
  {
    group: 'Mensagens',
    endpoints: [
      { method: 'POST', path: `${BASE}/messages`, summary: 'Envia mensagem', curl: `curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"conversationId":"<id>","type":"TEXT","content":{"text":"Olá!"}}' "$BASE/messages"` },
    ],
  },
];
```

- [ ] **Step 2: Commit**

```bash
cd chat-bullq-web
git add src/features/settings/data/public-api-endpoints.ts
git commit -m "feat(web): public API endpoints reference data"
```

---

## Task 16: Front — componente ApiReference + integração na página

**Files:**
- Create: `chat-bullq-web/src/features/settings/components/api-reference.tsx`
- Modify: `chat-bullq-web/src/app/(dashboard)/settings/api-keys/page.tsx`

- [ ] **Step 1: Write the component**

```tsx
// api-reference.tsx
'use client';

import { useState } from 'react';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { PUBLIC_API_ENDPOINTS } from '@/features/settings/data/public-api-endpoints';

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
  POST: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  PATCH: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20',
  DELETE: 'text-red-600 bg-red-50 dark:bg-red-900/20',
};

export function ApiReference() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
  };

  return (
    <div className="mt-10 border-t border-zinc-200 pt-8 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">API Pública (REST)</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            Autentique com <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">Authorization: Bearer &lt;API_KEY&gt;</code>.
          </p>
        </div>
        <a
          href="/docs/public" target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <ExternalLink className="h-4 w-4" /> Documentação interativa
        </a>
      </div>

      <div className="mt-6 space-y-6">
        {PUBLIC_API_ENDPOINTS.map((group) => (
          <div key={group.group}>
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">{group.group}</h3>
            <div className="mt-2 space-y-2">
              {group.endpoints.map((ep) => {
                const id = `${ep.method}-${ep.path}`;
                return (
                  <div key={id} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-bold ${METHOD_COLORS[ep.method]}`}>{ep.method}</span>
                      <code className="text-xs text-zinc-700 dark:text-zinc-300">{ep.path}</code>
                      <span className="ml-auto text-xs text-zinc-400">{ep.summary}</span>
                    </div>
                    <div className="mt-2 flex items-start gap-2">
                      <pre className="flex-1 overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-[11px] leading-relaxed text-zinc-100">{ep.curl}</pre>
                      <button onClick={() => copy(ep.curl, id)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Copiar">
                        {copied === id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render it in the page**

Em `settings/api-keys/page.tsx`, adicionar o import no topo:
```tsx
import { ApiReference } from '@/features/settings/components/api-reference';
```
E antes do fechamento do `</div>` raiz do `return` (após o bloco de listagem de chaves e antes do modal `{createdKey && ...}`), inserir:
```tsx
      <ApiReference />
```

- [ ] **Step 3: Verify**

Run: `cd chat-bullq-web && yarn dev`, abrir `/settings/api-keys`.
Expected: página mostra chaves (como antes) + seção "API Pública (REST)" com endpoints, curl copiável e botão pra `/docs/public`.

- [ ] **Step 4: Lint/build + commit**

```bash
cd chat-bullq-web
yarn build
git add src/features/settings/components/api-reference.tsx "src/app/(dashboard)/settings/api-keys/page.tsx"
git commit -m "feat(web): public API reference section in Admin"
```

---

## Task 17: Suíte completa + revisão final

- [ ] **Step 1: Rodar toda a suíte do backend**

Run: `cd chat-bullq-api && yarn test`
Expected: todos os specs passam (mappers, guard, contacts.create, + specs pré-existentes intactos).

- [ ] **Step 2: Typecheck + build backend**

Run: `yarn typecheck && yarn build`
Expected: sem erros.

- [ ] **Step 3: Build front**

Run: `cd ../chat-bullq-web && yarn build`
Expected: sem erros.

- [ ] **Step 4: Checklist de verificação manual (smoke)**

Com a API rodando e uma API-key válida, confirmar cada um:
- `GET /public/contacts` → página `{items,page,limit,total,hasMore}`.
- `POST /public/contacts` (2x com mesmo phone+channel) → mesmo contato (idempotente).
- `GET /public/conversations?status=OPEN` → lista.
- `GET /public/conversations/:id/messages` → mensagens paginadas.
- `POST /public/messages` → mensagem enviada e visível na conversa.
- `POST /public/conversations/:id/close` → status muda.
- Sem header Authorization → 401.
- Estourar 100 req/5s → 429.

- [ ] **Step 5: Commit final (se houver ajustes dos fallbacks)**

```bash
cd ../chat-bullq-api
git add -A && git commit -m "chore(public-api): finalize phase-1 shapes after smoke test"
```

---

## Notas de execução

- **Aditivo:** nenhuma task altera comportamento de endpoint/serviço existente. As únicas modificações em arquivos existentes são: (a) `contacts.service.ts`/`contacts.repository.ts` — só **adicionam** métodos; (b) `public-api.module.ts` — só adiciona controllers/imports; (c) `main.ts` — só adiciona um segundo Swagger; (d) `channel-hub.module.ts` — só adiciona export se faltar; (e) página do Admin — só adiciona uma seção.
- **Git:** o projeto não é um repo git hoje. Antes da Task 1, decidir com o usuário se roda `git init` (os `git commit` das tasks assumem repo inicializado). Se optar por não versionar, ignorar os steps de commit.
- **Fallbacks defensivos** nos controllers de conversas/mensagens (`result.x ?? result.items ?? result`) existem porque o shape exato do retorno de `findInbox`/`findByConversation`/`send` não foi 100% capturado na leitura. Na Task 17 (smoke), fixar o shape real e remover os ramos mortos.
```
