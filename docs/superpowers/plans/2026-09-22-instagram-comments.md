# Central de Comentários do Instagram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receber comentários de posts do Instagram por webhook, guardar em tabela própria e dar à equipe uma tela para responder, ocultar, deletar, abrir DM com o autor e pedir sugestão de resposta à IA.

**Architecture:** Backend NestJS (`chat-bullq-api`) ganha um model `SocialComment`, o adapter Instagram passa a parsear `entry[].changes[field=comments]`, o gateway enfileira `process-comment` na fila `inbound-messages` existente e um novo módulo `social-comments` faz ingest, ações via Graph API e realtime. Frontend Next (`chat-bullq-web`) ganha rota `/comments` com feature `features/comments` (react-query + socket).

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), BullMQ, socket.io, Jest + ts-jest. Next 16, React 19, @tanstack/react-query 5, socket.io-client, sonner, lucide-react, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-09-22-instagram-comments-design.md`

## Global Constraints

- Só Instagram (`ChannelType.INSTAGRAM`). Nada de Facebook.
- Sem backfill de comentários antigos. Sem estado interno "lido/resolvido".
- Fila: reutilizar `inbound-messages`. Não criar fila nova. Não criar segundo `@Processor('inbound-messages')`.
- Realtime: sempre `RealtimeGateway.emitToChannel(channelId, ...)`. Eventos: `comment:new`, `comment:updated`.
- Ações que chamam Graph API: nada muda no banco se a Graph falhar. Erro sobe como `BadGatewayException` com a mensagem da Meta.
- Private reply: exatamente uma por comentário. Segunda tentativa retorna 409 com `conversationId`.
- Delete só OWNER/ADMIN. Demais ações: qualquer membro com acesso ao canal.
- Commits: mensagens em português, prefixo `feat(social-comments):` / `feat(comments):` no front. **Nunca** adicionar linha `Co-Authored-By` nem menção a IA.
- Texto de UI em português.
- Backend: rodar `npx jest <spec>` por task e `npm run typecheck` antes de cada commit. Front: `npx tsc --noEmit` e `npm run lint` antes de cada commit.

Caminhos: `API = C:\Users\e_say\Documents\GitHub\chat-bullq-api`, `WEB = C:\Users\e_say\Documents\GitHub\chat-bullq-web`.

---

## File Structure

### Backend (`chat-bullq-api`)

| Arquivo | Responsabilidade |
|---|---|
| `prisma/schema.prisma` | enum `SocialCommentStatus`, model `SocialComment`, relações em `Organization` e `Channel` |
| `prisma/migrations/<ts>_add_social_comments/migration.sql` | DDL |
| `src/modules/channel-hub/ports/types/normalized-message.types.ts` | `NormalizedComment`, `WebhookParseResult.comments?` |
| `src/modules/channel-hub/adapters/instagram/instagram.message-mapper.ts` | `normalizeComment()` puro |
| `src/modules/channel-hub/adapters/instagram/instagram.message-mapper.spec.ts` | testes do mapper |
| `src/modules/channel-hub/adapters/instagram/instagram.inbound-adapter.ts` | parse de `entry[].changes` |
| `src/modules/channel-hub/adapters/instagram/instagram.inbound-adapter.spec.ts` | testes do parse |
| `src/modules/channel-hub/adapters/instagram/instagram.http-client.ts` | `getMedia`, `replyToComment`, `deleteComment`, `setCommentHidden`, `sendPrivateReply` |
| `src/modules/channel-hub/webhook-gateway.controller.ts` | enfileira `process-comment` |
| `src/modules/social-comments/social-comments.module.ts` | wiring |
| `src/modules/social-comments/social-comments.repository.ts` | acesso Prisma (upsert, list, thread) |
| `src/modules/social-comments/social-comments-ingest.service.ts` | `ingest()` chamado pelo processor |
| `src/modules/social-comments/social-comments-ingest.service.spec.ts` | testes do ingest |
| `src/modules/social-comments/social-comments.service.ts` | list + ações (reply/hide/delete/privateReply/suggest) |
| `src/modules/social-comments/social-comments.service.spec.ts` | testes das ações |
| `src/modules/social-comments/social-comments.controller.ts` | rotas REST |
| `src/modules/social-comments/dto/*.dto.ts` | validação |
| `src/modules/messaging/pipeline/inbound-message.processor.ts` | delega `process-comment` |
| `src/modules/messaging/pipeline/contact-resolver.service.ts` | `resolveByExternalId()` |
| `src/modules/messaging/messaging.module.ts` | exporta resolvers + `MessagesRepository`, importa `SocialCommentsModule` |
| `src/app.module.ts` | registra `SocialCommentsModule` |

### Frontend (`chat-bullq-web`)

| Arquivo | Responsabilidade |
|---|---|
| `src/features/comments/services/comments.service.ts` | tipos + chamadas axios |
| `src/features/comments/hooks/use-comments.ts` | `useInfiniteQuery` da lista |
| `src/features/comments/hooks/use-comments-socket.ts` | invalida query em `comment:new`/`comment:updated` |
| `src/features/comments/components/comments-filters.tsx` | select canal + select status |
| `src/features/comments/components/comment-list.tsx` | página inteira: header, filtros, lista, empty state, carregar mais |
| `src/features/comments/components/comment-card.tsx` | card do comentário raiz + thread + ações |
| `src/features/comments/components/comment-reply-box.tsx` | textarea + Sugerir com IA + Responder |
| `src/features/comments/components/private-reply-dialog.tsx` | modal de DM |
| `src/app/(dashboard)/comments/page.tsx` | rota |
| `src/components/layout/app-sidebar.tsx` | item "Comentários" |

---

## Task 1: Model Prisma `SocialComment` + migration

**Files:**
- Modify: `API/prisma/schema.prisma` (enum após `ChannelVisibility` ~linha 35; model após `InternalNote` ~linha 629; relações em `Organization` e `Channel`)
- Create: `API/prisma/migrations/20260922120000_add_social_comments/migration.sql`

**Interfaces:**
- Produces: Prisma client com `prisma.socialComment`, enum `SocialCommentStatus` (`VISIBLE | HIDDEN | DELETED`).

- [ ] **Step 1: Adicionar enum e model ao schema**

Logo após o enum `ChannelVisibility` adicionar:

```prisma
enum SocialCommentStatus {
  VISIBLE
  HIDDEN
  DELETED
}
```

Logo após o model `InternalNote` adicionar:

```prisma
// ─── Social comments (comentários públicos em posts do Instagram) ────
//
// Chegam por webhook (`entry[].changes[field=comments]`). `isFromPage` marca
// replies feitas pela própria conta (via sistema ou pelo app do IG).
// `repliedAt` no comentário raiz = a página já respondeu publicamente.
model SocialComment {
  id                         String              @id @default(cuid())
  organizationId             String              @map("organization_id")
  channelId                  String              @map("channel_id")
  externalId                 String              @map("external_id")
  parentExternalId           String?             @map("parent_external_id")
  mediaId                    String              @map("media_id")
  mediaPermalink             String?             @map("media_permalink")
  mediaCaption               String?             @map("media_caption") @db.Text
  mediaThumbnailUrl          String?             @map("media_thumbnail_url")
  authorExternalId           String              @map("author_external_id")
  authorUsername             String?             @map("author_username")
  text                       String              @db.Text
  status                     SocialCommentStatus @default(VISIBLE)
  isFromPage                 Boolean             @default(false) @map("is_from_page")
  repliedAt                  DateTime?           @map("replied_at")
  repliedById                String?             @map("replied_by_id")
  privateReplyConversationId String?             @map("private_reply_conversation_id")
  commentedAt                DateTime            @map("commented_at")
  createdAt                  DateTime            @default(now()) @map("created_at")
  updatedAt                  DateTime            @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  channel      Channel      @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@unique([channelId, externalId], name: "uq_social_comment_external")
  @@index([organizationId, commentedAt], name: "idx_social_comment_org_time")
  @@index([channelId, mediaId], name: "idx_social_comment_media")
  @@index([channelId, parentExternalId], name: "idx_social_comment_thread")
  @@map("social_comments")
}
```

No model `Organization`, na lista de relações, adicionar `socialComments SocialComment[]`.
No model `Channel`, após `primaryOfSegments`, adicionar `socialComments SocialComment[]`.

- [ ] **Step 2: Criar a migration**

Tentar `npx prisma migrate dev --name add_social_comments` (usa `DATABASE_URL` do `.env`). Se não houver banco acessível, criar manualmente `prisma/migrations/20260922120000_add_social_comments/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "SocialCommentStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED');

-- CreateTable
CREATE TABLE "social_comments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "parent_external_id" TEXT,
    "media_id" TEXT NOT NULL,
    "media_permalink" TEXT,
    "media_caption" TEXT,
    "media_thumbnail_url" TEXT,
    "author_external_id" TEXT NOT NULL,
    "author_username" TEXT,
    "text" TEXT NOT NULL,
    "status" "SocialCommentStatus" NOT NULL DEFAULT 'VISIBLE',
    "is_from_page" BOOLEAN NOT NULL DEFAULT false,
    "replied_at" TIMESTAMP(3),
    "replied_by_id" TEXT,
    "private_reply_conversation_id" TEXT,
    "commented_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_comments_channel_id_external_id_key" ON "social_comments"("channel_id", "external_id");
CREATE INDEX "idx_social_comment_org_time" ON "social_comments"("organization_id", "commented_at");
CREATE INDEX "idx_social_comment_media" ON "social_comments"("channel_id", "media_id");
CREATE INDEX "idx_social_comment_thread" ON "social_comments"("channel_id", "parent_external_id");

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Depois: `npx prisma generate`.

- [ ] **Step 3: Verificar**

Run: `npm run typecheck`
Expected: sem erros. `node -e "console.log(Object.keys(require('@prisma/client').SocialCommentStatus))"` imprime `[ 'VISIBLE', 'HIDDEN', 'DELETED' ]`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(social-comments): model SocialComment e migration"
```

---

## Task 2: Tipo `NormalizedComment` + `normalizeComment()` no mapper

**Files:**
- Modify: `API/src/modules/channel-hub/ports/types/normalized-message.types.ts` (após `WebhookParseResult` ~linha 205)
- Modify: `API/src/modules/channel-hub/adapters/instagram/instagram.message-mapper.ts`
- Create: `API/src/modules/channel-hub/adapters/instagram/instagram.message-mapper.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NormalizedComment {
    externalId: string;
    parentExternalId?: string;
    mediaId: string;
    mediaProductType?: string;
    authorExternalId: string;
    authorUsername?: string;
    text: string;
    commentedAt: Date;
    rawPayload: unknown;
  }
  // em WebhookParseResult:
  comments?: NormalizedComment[];
  // no mapper:
  normalizeComment(value: Record<string, any>, entryTimeSeconds?: number): NormalizedComment | null
  ```

- [ ] **Step 1: Escrever o teste que falha**

```ts
// instagram.message-mapper.spec.ts
import { InstagramMessageMapper } from './instagram.message-mapper';

const mapper = new InstagramMessageMapper();

describe('InstagramMessageMapper.normalizeComment', () => {
  const base = {
    id: '17890000000000001',
    text: 'Quanto custa?',
    from: { id: '5550001', username: 'maria.s' },
    media: { id: '18000000000000002', media_product_type: 'FEED' },
  };

  it('normaliza comentário raiz', () => {
    const out = mapper.normalizeComment(base, 1758542400);
    expect(out).toEqual({
      externalId: '17890000000000001',
      parentExternalId: undefined,
      mediaId: '18000000000000002',
      mediaProductType: 'FEED',
      authorExternalId: '5550001',
      authorUsername: 'maria.s',
      text: 'Quanto custa?',
      commentedAt: new Date(1758542400 * 1000),
      rawPayload: base,
    });
  });

  it('normaliza reply com parent_id', () => {
    const out = mapper.normalizeComment({ ...base, parent_id: '17890000000000000' });
    expect(out?.parentExternalId).toBe('17890000000000000');
  });

  it('usa agora quando entry.time ausente', () => {
    const before = Date.now();
    const out = mapper.normalizeComment(base);
    expect(out!.commentedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('retorna null sem id, sem from.id ou sem media.id', () => {
    expect(mapper.normalizeComment({ ...base, id: undefined })).toBeNull();
    expect(mapper.normalizeComment({ ...base, from: {} })).toBeNull();
    expect(mapper.normalizeComment({ ...base, media: {} })).toBeNull();
  });

  it('texto ausente vira string vazia', () => {
    expect(mapper.normalizeComment({ ...base, text: undefined })?.text).toBe('');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest src/modules/channel-hub/adapters/instagram/instagram.message-mapper.spec.ts`
Expected: FAIL, `mapper.normalizeComment is not a function`.

- [ ] **Step 3: Adicionar o tipo**

Em `normalized-message.types.ts`, alterar `WebhookParseResult` e adicionar a interface:

```ts
export interface WebhookParseResult {
  messages: NormalizedInboundMessage[];
  statuses: StatusUpdate[];
  errors: WebhookError[];
  /** Comentários públicos em posts (Instagram `changes[field=comments]`). */
  comments?: NormalizedComment[];
}

/** Comentário público num post/reel, normalizado a partir do webhook. */
export interface NormalizedComment {
  externalId: string;
  /** Presente quando é reply de outro comentário. */
  parentExternalId?: string;
  mediaId: string;
  mediaProductType?: string;
  authorExternalId: string;
  authorUsername?: string;
  text: string;
  commentedAt: Date;
  rawPayload: unknown;
}
```

- [ ] **Step 4: Implementar no mapper**

Adicionar `NormalizedComment` ao import de `'../../ports/types'` e o método público na classe `InstagramMessageMapper`:

```ts
  /**
   * `value` de `entry[].changes[]` com `field === 'comments'`:
   * `{ id, text, from: { id, username }, media: { id, media_product_type }, parent_id? }`.
   * `entryTimeSeconds` é `entry.time` (unix em segundos).
   */
  normalizeComment(
    value: Record<string, any>,
    entryTimeSeconds?: number,
  ): NormalizedComment | null {
    const externalId = value?.id ? String(value.id) : undefined;
    const authorExternalId = value?.from?.id ? String(value.from.id) : undefined;
    const mediaId = value?.media?.id ? String(value.media.id) : undefined;
    if (!externalId || !authorExternalId || !mediaId) return null;

    return {
      externalId,
      parentExternalId: value.parent_id ? String(value.parent_id) : undefined,
      mediaId,
      mediaProductType: value.media?.media_product_type,
      authorExternalId,
      authorUsername: value.from?.username,
      text: typeof value.text === 'string' ? value.text : '',
      commentedAt: entryTimeSeconds
        ? new Date(entryTimeSeconds * 1000)
        : new Date(),
      rawPayload: value,
    };
  }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest src/modules/channel-hub/adapters/instagram/instagram.message-mapper.spec.ts`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/modules/channel-hub/ports/types/normalized-message.types.ts src/modules/channel-hub/adapters/instagram/instagram.message-mapper.ts src/modules/channel-hub/adapters/instagram/instagram.message-mapper.spec.ts
git commit -m "feat(social-comments): tipo NormalizedComment e normalizeComment no mapper do Instagram"
```

---

## Task 3: Parse de `entry[].changes` no `InstagramInboundAdapter`

**Files:**
- Modify: `API/src/modules/channel-hub/adapters/instagram/instagram.inbound-adapter.ts:70-125` (método `parseWebhook`)
- Create: `API/src/modules/channel-hub/adapters/instagram/instagram.inbound-adapter.spec.ts`

**Interfaces:**
- Consumes: `mapper.normalizeComment(value, entryTime)` (Task 2).
- Produces: `parseWebhook(...)` retorna `comments: NormalizedComment[]` (sempre array, pode ser vazio).

- [ ] **Step 1: Escrever o teste que falha**

```ts
// instagram.inbound-adapter.spec.ts
import { ChannelType } from '@prisma/client';
import { InstagramInboundAdapter } from './instagram.inbound-adapter';
import { InstagramMessageMapper } from './instagram.message-mapper';

const adapter = new InstagramInboundAdapter(new InstagramMessageMapper());

const channel = {
  id: 'ch1',
  type: ChannelType.INSTAGRAM,
  config: { igBusinessId: '1784' },
} as any;

const commentChange = {
  field: 'comments',
  value: {
    id: '17890000000000001',
    text: 'Quanto custa?',
    from: { id: '5550001', username: 'maria.s' },
    media: { id: '18000000000000002', media_product_type: 'FEED' },
  },
};

describe('InstagramInboundAdapter.parseWebhook — comments', () => {
  it('extrai comentários de entry.changes junto com mensagens', () => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: '1784',
          time: 1758542400,
          changes: [commentChange],
          messaging: [
            {
              sender: { id: '999' },
              recipient: { id: '1784' },
              timestamp: 1758542400000,
              message: { mid: 'm1', text: 'oi' },
            },
          ],
        },
      ],
    };

    const out = adapter.parseWebhook(payload, channel);
    expect(out.messages).toHaveLength(1);
    expect(out.comments).toHaveLength(1);
    expect(out.comments![0]).toMatchObject({
      externalId: '17890000000000001',
      mediaId: '18000000000000002',
      authorExternalId: '5550001',
      commentedAt: new Date(1758542400 * 1000),
    });
  });

  it('ignora changes de outro entry.id', () => {
    const out = adapter.parseWebhook(
      { entry: [{ id: '0000', changes: [commentChange] }] },
      channel,
    );
    expect(out.comments).toEqual([]);
  });

  it('ignora changes com field diferente de comments', () => {
    const out = adapter.parseWebhook(
      { entry: [{ id: '1784', changes: [{ ...commentChange, field: 'mentions' }] }] },
      channel,
    );
    expect(out.comments).toEqual([]);
  });

  it('payload sem changes retorna comments vazio', () => {
    const out = adapter.parseWebhook({ entry: [{ id: '1784' }] }, channel);
    expect(out.comments).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest src/modules/channel-hub/adapters/instagram/instagram.inbound-adapter.spec.ts`
Expected: FAIL (`out.comments` é `undefined`).

- [ ] **Step 3: Implementar**

Em `parseWebhook`, inicializar `comments: []` no `result` e, dentro do loop de `entries`, após o `for` de `messagingEvents`, adicionar:

```ts
        const changes: any[] = entry?.changes || [];
        for (const change of changes) {
          if (change?.field !== 'comments') continue;
          const normalized = this.mapper.normalizeComment(
            change.value ?? {},
            typeof entry?.time === 'number' ? entry.time : undefined,
          );
          if (normalized) {
            result.comments!.push(normalized);
          }
        }
```

O `result` inicial fica:

```ts
    const result: WebhookParseResult = {
      messages: [],
      statuses: [],
      errors: [],
      comments: [],
    };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest src/modules/channel-hub/adapters/instagram`
Expected: todos passam (mapper + adapter).

- [ ] **Step 5: Commit**

```bash
git add src/modules/channel-hub/adapters/instagram/instagram.inbound-adapter.ts src/modules/channel-hub/adapters/instagram/instagram.inbound-adapter.spec.ts
git commit -m "feat(social-comments): adapter Instagram parseia entry.changes de comentarios"
```

---

## Task 4: Métodos de comentário no `InstagramHttpClient`

**Files:**
- Modify: `API/src/modules/channel-hub/adapters/instagram/instagram.http-client.ts` (antes de `wrapGraphError`, ~linha 219)

**Interfaces:**
- Produces:
  ```ts
  getMedia(channel, mediaId): Promise<{ id: string; permalink?: string; caption?: string; media_type?: string; thumbnail_url?: string; media_url?: string }>
  replyToComment(channel, commentId, message): Promise<{ id: string }>
  deleteComment(channel, commentId): Promise<void>
  setCommentHidden(channel, commentId, hide: boolean): Promise<void>
  sendPrivateReply(channel, commentId, text): Promise<{ recipient_id?: string; message_id?: string }>
  ```

- [ ] **Step 1: Implementar**

```ts
  // ─── Comentários em posts ─────────────────────────────────────────

  async getMedia(
    channel: Channel,
    mediaId: string,
  ): Promise<{
    id: string;
    permalink?: string;
    caption?: string;
    media_type?: string;
    thumbnail_url?: string;
    media_url?: string;
  }> {
    const client = this.createClient(channel);
    try {
      const { data } = await client.get(`/${mediaId}`, {
        params: {
          fields: 'id,permalink,caption,media_type,thumbnail_url,media_url',
        },
      });
      return data;
    } catch (err: any) {
      throw this.wrapGraphError(err, 'getMedia');
    }
  }

  async replyToComment(
    channel: Channel,
    commentId: string,
    message: string,
  ): Promise<{ id: string }> {
    const client = this.createClient(channel);
    try {
      const { data } = await client.post(`/${commentId}/replies`, { message });
      return data;
    } catch (err: any) {
      throw this.wrapGraphError(err, 'replyToComment');
    }
  }

  async deleteComment(channel: Channel, commentId: string): Promise<void> {
    const client = this.createClient(channel);
    try {
      await client.delete(`/${commentId}`);
    } catch (err: any) {
      throw this.wrapGraphError(err, 'deleteComment');
    }
  }

  async setCommentHidden(
    channel: Channel,
    commentId: string,
    hide: boolean,
  ): Promise<void> {
    const client = this.createClient(channel);
    try {
      await client.post(`/${commentId}`, { hide });
    } catch (err: any) {
      throw this.wrapGraphError(err, 'setCommentHidden');
    }
  }

  /**
   * Private Reply: DM iniciada a partir de um comentário. Meta permite uma
   * por comentário, até 7 dias depois dele, fora da regra das 24h.
   */
  async sendPrivateReply(
    channel: Channel,
    commentId: string,
    text: string,
  ): Promise<{ recipient_id?: string; message_id?: string }> {
    return this.sendMessage(channel, {
      recipient: { comment_id: commentId },
      message: { text },
    });
  }
```

- [ ] **Step 2: Verificar**

Run: `npm run typecheck`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/modules/channel-hub/adapters/instagram/instagram.http-client.ts
git commit -m "feat(social-comments): metodos de comentario no InstagramHttpClient"
```

---

## Task 5: Módulo `social-comments` — repository + ingest service + wiring da fila

**Files:**
- Create: `API/src/modules/social-comments/social-comments.repository.ts`
- Create: `API/src/modules/social-comments/social-comments-ingest.service.ts`
- Create: `API/src/modules/social-comments/social-comments-ingest.service.spec.ts`
- Create: `API/src/modules/social-comments/social-comments.module.ts`
- Modify: `API/src/modules/channel-hub/webhook-gateway.controller.ts:118-160`
- Modify: `API/src/modules/messaging/pipeline/inbound-message.processor.ts:29-42, 71-112`
- Modify: `API/src/modules/messaging/messaging.module.ts`
- Modify: `API/src/app.module.ts`

**Interfaces:**
- Consumes: `NormalizedComment` (Task 2), `InstagramHttpClient.getMedia` (Task 4), `RealtimeGateway.emitToChannel`.
- Produces:
  ```ts
  // repository
  findThread(channelId, rootExternalId): Promise<SocialComment & { replies: SocialComment[] } | null>
  serialize(root: SocialComment, replies: SocialComment[]): SocialCommentView
  // ingest
  interface CommentJobData { channelId: string; organizationId: string; webhookEventId?: string; comment: NormalizedComment }
  ingest(data: CommentJobData): Promise<{ created: boolean }>
  ```
  `SocialCommentView` = campos do model (datas como `Date`) + `replies: SocialComment[]`.

- [ ] **Step 1: Repository**

```ts
// social-comments.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, SocialComment, SocialCommentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type SocialCommentView = SocialComment & { replies: SocialComment[] };

export interface ListRootsParams {
  organizationId: string;
  /** Canais permitidos. `undefined` = todos da org. */
  channelIds?: string[];
  channelId?: string;
  status?: SocialCommentStatus;
  unreplied?: boolean;
  cursor?: string;
  limit: number;
}

@Injectable()
export class SocialCommentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.socialComment.findUnique({ where: { id } });
  }

  findByExternal(channelId: string, externalId: string) {
    return this.prisma.socialComment.findUnique({
      where: { uq_social_comment_external: { channelId, externalId } },
    });
  }

  upsertFromWebhook(data: {
    organizationId: string;
    channelId: string;
    externalId: string;
    parentExternalId?: string;
    mediaId: string;
    authorExternalId: string;
    authorUsername?: string;
    text: string;
    isFromPage: boolean;
    commentedAt: Date;
  }) {
    return this.prisma.socialComment.upsert({
      where: {
        uq_social_comment_external: {
          channelId: data.channelId,
          externalId: data.externalId,
        },
      },
      create: {
        organizationId: data.organizationId,
        channelId: data.channelId,
        externalId: data.externalId,
        parentExternalId: data.parentExternalId ?? null,
        mediaId: data.mediaId,
        authorExternalId: data.authorExternalId,
        authorUsername: data.authorUsername ?? null,
        text: data.text,
        isFromPage: data.isFromPage,
        commentedAt: data.commentedAt,
      },
      update: {
        text: data.text,
        authorUsername: data.authorUsername ?? undefined,
      },
    });
  }

  update(id: string, data: Prisma.SocialCommentUncheckedUpdateInput) {
    return this.prisma.socialComment.update({ where: { id }, data });
  }

  /** Marca o pai como respondido se ainda não estava. */
  async markParentReplied(
    channelId: string,
    parentExternalId: string,
    repliedById: string | null,
  ) {
    await this.prisma.socialComment.updateMany({
      where: { channelId, externalId: parentExternalId, repliedAt: null },
      data: { repliedAt: new Date(), repliedById },
    });
  }

  /** Copia dados da mídia de um irmão já enriquecido (mesmo post). */
  findEnrichedSibling(channelId: string, mediaId: string) {
    return this.prisma.socialComment.findFirst({
      where: { channelId, mediaId, mediaPermalink: { not: null } },
      select: { mediaPermalink: true, mediaCaption: true, mediaThumbnailUrl: true },
    });
  }

  async applyMediaToAll(
    channelId: string,
    mediaId: string,
    media: { mediaPermalink?: string | null; mediaCaption?: string | null; mediaThumbnailUrl?: string | null },
  ) {
    await this.prisma.socialComment.updateMany({
      where: { channelId, mediaId, mediaPermalink: null },
      data: media,
    });
  }

  async findThread(channelId: string, rootExternalId: string): Promise<SocialCommentView | null> {
    const root = await this.findByExternal(channelId, rootExternalId);
    if (!root) return null;
    const replies = await this.prisma.socialComment.findMany({
      where: { channelId, parentExternalId: rootExternalId },
      orderBy: { commentedAt: 'asc' },
    });
    return { ...root, replies };
  }

  async listRoots(params: ListRootsParams): Promise<{ items: SocialCommentView[]; nextCursor: string | null }> {
    const where: Prisma.SocialCommentWhereInput = {
      organizationId: params.organizationId,
      parentExternalId: null,
    };
    if (params.channelIds) where.channelId = { in: params.channelIds };
    if (params.channelId) where.channelId = params.channelId;
    if (params.status) where.status = params.status;
    if (params.unreplied) {
      where.repliedAt = null;
      where.status = SocialCommentStatus.VISIBLE;
    }

    const roots = await this.prisma.socialComment.findMany({
      where,
      orderBy: [{ commentedAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = roots.length > params.limit;
    const page = hasMore ? roots.slice(0, params.limit) : roots;
    if (page.length === 0) return { items: [], nextCursor: null };

    const replies = await this.prisma.socialComment.findMany({
      where: {
        channelId: { in: [...new Set(page.map((r) => r.channelId))] },
        parentExternalId: { in: page.map((r) => r.externalId) },
      },
      orderBy: { commentedAt: 'asc' },
    });
    const byParent = new Map<string, SocialComment[]>();
    for (const r of replies) {
      const key = `${r.channelId}:${r.parentExternalId}`;
      byParent.set(key, [...(byParent.get(key) ?? []), r]);
    }

    return {
      items: page.map((root) => ({
        ...root,
        replies: byParent.get(`${root.channelId}:${root.externalId}`) ?? [],
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
```

- [ ] **Step 2: Teste do ingest que falha**

```ts
// social-comments-ingest.service.spec.ts
import { SocialCommentsIngestService } from './social-comments-ingest.service';

const channel = { id: 'ch1', organizationId: 'org1', config: { igBusinessId: '1784' } };

function build() {
  const prisma = { channel: { findUnique: jest.fn().mockResolvedValue(channel) } };
  const repo = {
    findByExternal: jest.fn().mockResolvedValue(null),
    upsertFromWebhook: jest.fn(),
    markParentReplied: jest.fn().mockResolvedValue(undefined),
    findEnrichedSibling: jest.fn().mockResolvedValue(null),
    applyMediaToAll: jest.fn().mockResolvedValue(undefined),
    findThread: jest.fn(),
  };
  const http = { getMedia: jest.fn() };
  const realtime = { emitToChannel: jest.fn() };
  const service = new SocialCommentsIngestService(
    prisma as any,
    repo as any,
    http as any,
    realtime as any,
  );
  return { service, prisma, repo, http, realtime };
}

const comment = {
  externalId: 'c1',
  mediaId: 'm1',
  authorExternalId: '5550001',
  authorUsername: 'maria.s',
  text: 'Quanto custa?',
  commentedAt: new Date('2026-09-22T12:00:00Z'),
  rawPayload: {},
};

describe('SocialCommentsIngestService.ingest', () => {
  it('comentário raiz novo: upsert, enriquece mídia e emite comment:new', async () => {
    const { service, repo, http, realtime } = build();
    const saved = { id: 's1', ...comment, channelId: 'ch1', parentExternalId: null, isFromPage: false };
    repo.upsertFromWebhook.mockResolvedValue(saved);
    http.getMedia.mockResolvedValue({ id: 'm1', permalink: 'https://ig/p/x', caption: 'Promo', media_type: 'IMAGE', media_url: 'https://cdn/x.jpg' });
    repo.findThread.mockResolvedValue({ ...saved, mediaPermalink: 'https://ig/p/x', replies: [] });

    const out = await service.ingest({ channelId: 'ch1', organizationId: 'org1', comment });

    expect(out).toEqual({ created: true });
    expect(repo.upsertFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'ch1', externalId: 'c1', isFromPage: false }),
    );
    expect(repo.applyMediaToAll).toHaveBeenCalledWith('ch1', 'm1', {
      mediaPermalink: 'https://ig/p/x',
      mediaCaption: 'Promo',
      mediaThumbnailUrl: 'https://cdn/x.jpg',
    });
    expect(realtime.emitToChannel).toHaveBeenCalledWith('ch1', 'comment:new', expect.objectContaining({ id: 's1' }));
  });

  it('reprocessar o mesmo comentário não cria de novo e não emite', async () => {
    const { service, repo, realtime } = build();
    repo.findByExternal.mockResolvedValue({ id: 's1' });
    repo.upsertFromWebhook.mockResolvedValue({ id: 's1', ...comment, channelId: 'ch1', parentExternalId: null, isFromPage: false });
    repo.findEnrichedSibling.mockResolvedValue({ mediaPermalink: 'x' });

    const out = await service.ingest({ channelId: 'ch1', organizationId: 'org1', comment });

    expect(out).toEqual({ created: false });
    expect(realtime.emitToChannel).not.toHaveBeenCalled();
  });

  it('reply da própria página marca o pai como respondido e emite comment:updated', async () => {
    const { service, repo, realtime } = build();
    const reply = { ...comment, externalId: 'c2', parentExternalId: 'c1', authorExternalId: '1784' };
    repo.upsertFromWebhook.mockResolvedValue({ id: 's2', ...reply, channelId: 'ch1', isFromPage: true });
    repo.findEnrichedSibling.mockResolvedValue({ mediaPermalink: 'x' });
    repo.findThread.mockResolvedValue({ id: 's1', externalId: 'c1', replies: [{ id: 's2' }] });

    await service.ingest({ channelId: 'ch1', organizationId: 'org1', comment: reply });

    expect(repo.upsertFromWebhook).toHaveBeenCalledWith(expect.objectContaining({ isFromPage: true }));
    expect(repo.markParentReplied).toHaveBeenCalledWith('ch1', 'c1', null);
    expect(realtime.emitToChannel).toHaveBeenCalledWith('ch1', 'comment:updated', expect.objectContaining({ id: 's1' }));
  });

  it('falha no getMedia não derruba o ingest', async () => {
    const { service, repo, http } = build();
    repo.upsertFromWebhook.mockResolvedValue({ id: 's1', ...comment, channelId: 'ch1', parentExternalId: null, isFromPage: false });
    http.getMedia.mockRejectedValue(new Error('boom'));
    repo.findThread.mockResolvedValue({ id: 's1', replies: [] });

    await expect(service.ingest({ channelId: 'ch1', organizationId: 'org1', comment })).resolves.toEqual({ created: true });
    expect(repo.applyMediaToAll).not.toHaveBeenCalled();
  });

  it('canal inexistente: ignora', async () => {
    const { service, prisma, repo } = build();
    prisma.channel.findUnique.mockResolvedValue(null);
    await expect(service.ingest({ channelId: 'nope', organizationId: 'org1', comment })).resolves.toEqual({ created: false });
    expect(repo.upsertFromWebhook).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx jest src/modules/social-comments/social-comments-ingest.service.spec.ts`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 4: Ingest service**

```ts
// social-comments-ingest.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { InstagramHttpClient } from '../channel-hub/adapters/instagram/instagram.http-client';
import { NormalizedComment } from '../channel-hub/ports/types';
import { SocialCommentsRepository } from './social-comments.repository';

export interface CommentJobData {
  channelId: string;
  organizationId: string;
  webhookEventId?: string;
  comment: NormalizedComment;
}

@Injectable()
export class SocialCommentsIngestService {
  private readonly logger = new Logger(SocialCommentsIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SocialCommentsRepository,
    private readonly instagram: InstagramHttpClient,
    private readonly realtime: RealtimeGateway,
  ) {}

  async ingest(data: CommentJobData): Promise<{ created: boolean }> {
    const { channelId, organizationId, comment } = data;
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      this.logger.warn(`Comment ${comment.externalId}: channel ${channelId} not found`);
      return { created: false };
    }

    const cfg = (channel.config ?? {}) as Record<string, any>;
    const igBusinessId = String(cfg.igBusinessId ?? cfg.igUserId ?? '');
    const isFromPage = !!igBusinessId && comment.authorExternalId === igBusinessId;

    const existed = await this.repo.findByExternal(channelId, comment.externalId);
    const saved = await this.repo.upsertFromWebhook({
      organizationId,
      channelId,
      externalId: comment.externalId,
      parentExternalId: comment.parentExternalId,
      mediaId: comment.mediaId,
      authorExternalId: comment.authorExternalId,
      authorUsername: comment.authorUsername,
      text: comment.text,
      isFromPage,
      commentedAt: comment.commentedAt,
    });
    const created = !existed;

    if (created && isFromPage && comment.parentExternalId) {
      await this.repo.markParentReplied(channelId, comment.parentExternalId, null);
    }

    await this.enrichMedia(channel, comment.mediaId);

    if (!created) return { created: false };

    const rootExternalId = comment.parentExternalId ?? comment.externalId;
    const thread = await this.repo.findThread(channelId, rootExternalId);
    if (thread) {
      const event = comment.parentExternalId ? 'comment:updated' : 'comment:new';
      this.realtime.emitToChannel(channelId, event, thread);
    }
    this.logger.log(`Comment ${saved.externalId} ingested (channel ${channelId}, fromPage=${isFromPage})`);
    return { created: true };
  }

  private async enrichMedia(channel: { id: string } & Record<string, any>, mediaId: string) {
    const sibling = await this.repo.findEnrichedSibling(channel.id, mediaId);
    if (sibling) {
      await this.repo.applyMediaToAll(channel.id, mediaId, sibling);
      return;
    }
    try {
      const media = await this.instagram.getMedia(channel as any, mediaId);
      await this.repo.applyMediaToAll(channel.id, mediaId, {
        mediaPermalink: media.permalink ?? null,
        mediaCaption: media.caption ?? null,
        mediaThumbnailUrl: media.thumbnail_url ?? media.media_url ?? null,
      });
    } catch (err: any) {
      this.logger.warn(`getMedia(${mediaId}) failed: ${err?.message ?? err}`);
    }
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest src/modules/social-comments/social-comments-ingest.service.spec.ts`
Expected: 5 passed.

- [ ] **Step 6: Módulo (só ingest por enquanto)**

```ts
// social-comments.module.ts
import { Module } from '@nestjs/common';
import { InstagramModule } from '../channel-hub/adapters/instagram/instagram.module';
import { SocialCommentsRepository } from './social-comments.repository';
import { SocialCommentsIngestService } from './social-comments-ingest.service';

@Module({
  imports: [InstagramModule],
  providers: [SocialCommentsRepository, SocialCommentsIngestService],
  exports: [SocialCommentsIngestService, SocialCommentsRepository],
})
export class SocialCommentsModule {}
```

Registrar em `app.module.ts`: importar `SocialCommentsModule` de `./modules/social-comments/social-comments.module` e adicionar à lista `imports` após `TagsModule`.

- [ ] **Step 7: Gateway enfileira `process-comment`**

Em `webhook-gateway.controller.ts`, após o loop de `parseResult.statuses` (antes do fechamento do `for` de canais):

```ts
      for (const comment of parseResult.comments ?? []) {
        await this.inboundQueue.add(
          'process-comment',
          {
            channelId: channel.id,
            organizationId: channel.organizationId,
            webhookEventId: eventId ?? undefined,
            comment,
          },
          {
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
        this.logger.log(
          `Enqueued comment: ${comment.externalId} → channel ${channel.id} (${channelType})`,
        );
      }
```

- [ ] **Step 8: Processor delega**

Em `inbound-message.processor.ts`:

```ts
import { SocialCommentsIngestService, CommentJobData } from '../../social-comments/social-comments-ingest.service';
```

No construtor adicionar `private readonly socialCommentsIngest: SocialCommentsIngestService,`.

No `process`, alterar a assinatura e o topo:

```ts
  async process(job: Job<InboundJobData | StatusJobData | CommentJobData>): Promise<any> {
    if (job.name === 'process-comment') {
      return this.socialCommentsIngest.ingest(job.data as CommentJobData);
    }
    if (job.name === 'process-status') {
      return this.processStatus(job.data as StatusJobData);
    }
```

Em `messaging.module.ts`: importar `SocialCommentsModule` e adicionar a `imports`.

- [ ] **Step 9: Verificar boot**

Run: `npm run typecheck` e `npx jest src/modules/social-comments src/modules/channel-hub/adapters/instagram`
Expected: sem erros, todos os specs passam.
Se houver banco e Redis locais: `npm run start:dev` sobe sem erro de DI (`Nest can't resolve dependencies`). Se der erro de dependência circular, envolver o import de `SocialCommentsModule` em `messaging.module.ts` com `forwardRef(() => SocialCommentsModule)` e injetar no processor com `@Inject(forwardRef(() => SocialCommentsIngestService))`.

- [ ] **Step 10: Commit**

```bash
git add src/modules/social-comments src/modules/channel-hub/webhook-gateway.controller.ts src/modules/messaging/pipeline/inbound-message.processor.ts src/modules/messaging/messaging.module.ts src/app.module.ts
git commit -m "feat(social-comments): ingest de comentarios via fila inbound-messages"
```

---

## Task 6: Service de ações (list, reply, hide, delete) + controller + DTOs

**Files:**
- Create: `API/src/modules/social-comments/dto/list-comments.query.dto.ts`
- Create: `API/src/modules/social-comments/dto/reply-comment.dto.ts`
- Create: `API/src/modules/social-comments/dto/hide-comment.dto.ts`
- Create: `API/src/modules/social-comments/social-comments.service.ts`
- Create: `API/src/modules/social-comments/social-comments.service.spec.ts`
- Create: `API/src/modules/social-comments/social-comments.controller.ts`
- Modify: `API/src/modules/social-comments/social-comments.module.ts`

**Interfaces:**
- Consumes: repository (Task 5), `InstagramHttpClient` (Task 4), `ChannelAccessService.hasAccess/assertChannelAccess`, `ChannelAccess = 'ALL' | Set<string>`.
- Produces:
  ```ts
  list(orgId, access, query: ListCommentsQueryDto): Promise<{ items: SocialCommentView[]; nextCursor: string | null }>
  reply(id, orgId, userId, access, text): Promise<SocialCommentView>
  setHidden(id, orgId, access, hidden): Promise<SocialCommentView>
  remove(id, orgId, access): Promise<SocialCommentView>
  ```
  Rotas: `GET /social-comments`, `POST /social-comments/:id/reply`, `PATCH /social-comments/:id/hide`, `DELETE /social-comments/:id`.

- [ ] **Step 1: DTOs**

```ts
// dto/list-comments.query.dto.ts
import { IsOptional, IsString, IsEnum, IsBooleanString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { SocialCommentStatus } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListCommentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() channelId?: string;
  @ApiPropertyOptional({ enum: SocialCommentStatus }) @IsOptional() @IsEnum(SocialCommentStatus) status?: SocialCommentStatus;
  @ApiPropertyOptional({ description: '"true" = só raízes sem resposta' }) @IsOptional() @IsBooleanString() unreplied?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
```

```ts
// dto/reply-comment.dto.ts
import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReplyCommentDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(2200) text: string;
}
```

```ts
// dto/hide-comment.dto.ts
import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class HideCommentDto {
  @ApiProperty() @IsBoolean() hidden: boolean;
}
```

Confirmar que `class-transformer` está em `package.json` (`grep class-transformer package.json`). Se não estiver, trocar `@Type(() => Number)` por leitura manual `Number(query.limit)` no service.

- [ ] **Step 2: Teste do service que falha**

```ts
// social-comments.service.spec.ts
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialCommentsService } from './social-comments.service';

const channel = { id: 'ch1', organizationId: 'org1', config: { igBusinessId: '1784' } };
const root = {
  id: 's1', organizationId: 'org1', channelId: 'ch1', externalId: 'c1', parentExternalId: null,
  mediaId: 'm1', authorExternalId: '5550001', authorUsername: 'maria.s', text: 'Quanto custa?',
  status: 'VISIBLE', isFromPage: false, repliedAt: null, privateReplyConversationId: null,
  commentedAt: new Date('2026-09-22T12:00:00Z'),
};

function build() {
  const prisma = {
    channel: { findUnique: jest.fn().mockResolvedValue(channel) },
  };
  const repo = {
    findById: jest.fn().mockResolvedValue(root),
    listRoots: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    upsertFromWebhook: jest.fn(),
    update: jest.fn().mockImplementation(async (_id, data) => ({ ...root, ...data })),
    markParentReplied: jest.fn().mockResolvedValue(undefined),
    findThread: jest.fn().mockResolvedValue({ ...root, replies: [] }),
  };
  const http = {
    replyToComment: jest.fn().mockResolvedValue({ id: 'c2' }),
    deleteComment: jest.fn().mockResolvedValue(undefined),
    setCommentHidden: jest.fn().mockResolvedValue(undefined),
  };
  const channelAccess = {
    hasAccess: jest.fn().mockReturnValue(true),
    assertChannelAccess: jest.fn(),
  };
  const realtime = { emitToChannel: jest.fn() };
  const service = new SocialCommentsService(
    prisma as any, repo as any, http as any, channelAccess as any, realtime as any,
    {} as any, {} as any, {} as any, {} as any,
  );
  return { service, prisma, repo, http, channelAccess, realtime };
}

describe('SocialCommentsService', () => {
  describe('list', () => {
    it('AGENT com Set de canais filtra por channelIds', async () => {
      const { service, repo } = build();
      await service.list('org1', new Set(['ch1', 'ch2']), { limit: 10 });
      expect(repo.listRoots).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org1', channelIds: ['ch1', 'ch2'], limit: 10 }),
      );
    });

    it('unreplied="true" vira boolean', async () => {
      const { service, repo } = build();
      await service.list('org1', 'ALL', { unreplied: 'true' });
      expect(repo.listRoots).toHaveBeenCalledWith(expect.objectContaining({ unreplied: true, channelIds: undefined, limit: 30 }));
    });
  });

  describe('reply', () => {
    it('chama Graph, grava reply isFromPage e marca pai', async () => {
      const { service, repo, http, realtime } = build();
      repo.upsertFromWebhook.mockResolvedValue({ id: 's2' });

      const out = await service.reply('s1', 'org1', 'u1', 'ALL', 'Custa R$ 99');

      expect(http.replyToComment).toHaveBeenCalledWith(channel, 'c1', 'Custa R$ 99');
      expect(repo.upsertFromWebhook).toHaveBeenCalledWith(expect.objectContaining({
        externalId: 'c2', parentExternalId: 'c1', authorExternalId: '1784', isFromPage: true, text: 'Custa R$ 99',
      }));
      expect(repo.markParentReplied).toHaveBeenCalledWith('ch1', 'c1', 'u1');
      expect(realtime.emitToChannel).toHaveBeenCalledWith('ch1', 'comment:updated', expect.objectContaining({ id: 's1' }));
      expect(out.id).toBe('s1');
    });

    it('Graph falhou: não persiste e sobe BadGateway', async () => {
      const { service, repo, http } = build();
      http.replyToComment.mockRejectedValue(new Error('[#10] permission denied'));
      await expect(service.reply('s1', 'org1', 'u1', 'ALL', 'x')).rejects.toBeInstanceOf(BadGatewayException);
      expect(repo.upsertFromWebhook).not.toHaveBeenCalled();
    });

    it('comentário de outra org: 404', async () => {
      const { service } = build();
      await expect(service.reply('s1', 'org2', 'u1', 'ALL', 'x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('comentário DELETED: 400', async () => {
      const { service, repo } = build();
      repo.findById.mockResolvedValue({ ...root, status: 'DELETED' });
      await expect(service.reply('s1', 'org1', 'u1', 'ALL', 'x')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('setHidden', () => {
    it('true => HIDDEN, false => VISIBLE', async () => {
      const { service, repo, http } = build();
      await service.setHidden('s1', 'org1', 'ALL', true);
      expect(http.setCommentHidden).toHaveBeenCalledWith(channel, 'c1', true);
      expect(repo.update).toHaveBeenCalledWith('s1', { status: 'HIDDEN' });
      await service.setHidden('s1', 'org1', 'ALL', false);
      expect(repo.update).toHaveBeenCalledWith('s1', { status: 'VISIBLE' });
    });
  });

  describe('remove', () => {
    it('chama Graph e marca DELETED', async () => {
      const { service, repo, http } = build();
      await service.remove('s1', 'org1', 'ALL');
      expect(http.deleteComment).toHaveBeenCalledWith(channel, 'c1');
      expect(repo.update).toHaveBeenCalledWith('s1', { status: 'DELETED' });
    });
  });
});
```

O construtor recebe 9 dependências (as 4 últimas são usadas nas Tasks 7 e 8: `ContactResolverService`, `ConversationResolverService`, `MessagesRepository`, `LlmService`). Nesta task, declarar todas já no construtor para não mudar assinatura depois.

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx jest src/modules/social-comments/social-comments.service.spec.ts`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 4: Service**

```ts
// social-comments.service.ts
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Channel, SocialComment, SocialCommentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { InstagramHttpClient } from '../channel-hub/adapters/instagram/instagram.http-client';
import { ChannelAccess, ChannelAccessService } from '../iam/channel-access/channel-access.service';
import { ContactResolverService } from '../messaging/pipeline/contact-resolver.service';
import { ConversationResolverService } from '../messaging/pipeline/conversation-resolver.service';
import { MessagesRepository } from '../messaging/messages/messages.repository';
import { LlmService } from '../ai-agents/llm/llm.service';
import { SocialCommentsRepository, SocialCommentView } from './social-comments.repository';
import { ListCommentsQueryDto } from './dto/list-comments.query.dto';

@Injectable()
export class SocialCommentsService {
  private readonly logger = new Logger(SocialCommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SocialCommentsRepository,
    private readonly instagram: InstagramHttpClient,
    private readonly channelAccess: ChannelAccessService,
    private readonly realtime: RealtimeGateway,
    private readonly contactResolver: ContactResolverService,
    private readonly conversationResolver: ConversationResolverService,
    private readonly messagesRepo: MessagesRepository,
    private readonly llm: LlmService,
  ) {}

  async list(orgId: string, access: ChannelAccess, query: ListCommentsQueryDto) {
    return this.repo.listRoots({
      organizationId: orgId,
      channelIds: access === 'ALL' ? undefined : [...access],
      channelId: query.channelId,
      status: query.status,
      unreplied: query.unreplied === 'true',
      cursor: query.cursor,
      limit: query.limit ?? 30,
    });
  }

  async reply(id: string, orgId: string, userId: string, access: ChannelAccess, text: string) {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    const res = await this.graph(() => this.instagram.replyToComment(channel, comment.externalId, text));

    const cfg = (channel.config ?? {}) as Record<string, any>;
    await this.repo.upsertFromWebhook({
      organizationId: orgId,
      channelId: channel.id,
      externalId: String(res.id),
      parentExternalId: comment.externalId,
      mediaId: comment.mediaId,
      authorExternalId: String(cfg.igBusinessId ?? cfg.igUserId ?? ''),
      authorUsername: channel.name,
      text,
      isFromPage: true,
      commentedAt: new Date(),
    });
    await this.repo.markParentReplied(channel.id, comment.externalId, userId);
    return this.emitThread(channel.id, comment.externalId);
  }

  async setHidden(id: string, orgId: string, access: ChannelAccess, hidden: boolean) {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    await this.graph(() => this.instagram.setCommentHidden(channel, comment.externalId, hidden));
    await this.repo.update(id, {
      status: hidden ? SocialCommentStatus.HIDDEN : SocialCommentStatus.VISIBLE,
    });
    return this.emitThread(channel.id, comment.parentExternalId ?? comment.externalId);
  }

  async remove(id: string, orgId: string, access: ChannelAccess) {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    await this.graph(() => this.instagram.deleteComment(channel, comment.externalId));
    await this.repo.update(id, { status: SocialCommentStatus.DELETED });
    return this.emitThread(channel.id, comment.parentExternalId ?? comment.externalId);
  }

  // ─── helpers ───────────────────────────────────────────────────────

  /** Carrega comentário + canal, valida org, acesso ao canal e status. */
  protected async loadActionable(
    id: string,
    orgId: string,
    access: ChannelAccess,
  ): Promise<{ comment: SocialComment; channel: Channel }> {
    const comment = await this.repo.findById(id);
    if (!comment || comment.organizationId !== orgId) {
      throw new NotFoundException('Comentário não encontrado');
    }
    this.channelAccess.assertChannelAccess(access, comment.channelId);
    if (comment.status === SocialCommentStatus.DELETED) {
      throw new BadRequestException('Comentário já foi deletado');
    }
    const channel = await this.prisma.channel.findUnique({ where: { id: comment.channelId } });
    if (!channel) throw new NotFoundException('Canal não encontrado');
    return { comment, channel };
  }

  /** Erro da Graph vira 502 com a mensagem da Meta. Nada foi persistido antes. */
  protected async graph<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      this.logger.warn(`Graph API error: ${err?.message ?? err}`);
      throw new BadGatewayException(err?.message ?? 'Erro na API do Instagram');
    }
  }

  protected async emitThread(channelId: string, rootExternalId: string): Promise<SocialCommentView> {
    const thread = await this.repo.findThread(channelId, rootExternalId);
    if (!thread) throw new NotFoundException('Comentário não encontrado');
    this.realtime.emitToChannel(channelId, 'comment:updated', thread);
    return thread;
  }
}
```

- [ ] **Step 5: Controller**

```ts
// social-comments.controller.ts
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentChannelAccess, CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { SocialCommentsService } from './social-comments.service';
import { ListCommentsQueryDto } from './dto/list-comments.query.dto';
import { ReplyCommentDto } from './dto/reply-comment.dto';
import { HideCommentDto } from './dto/hide-comment.dto';

@ApiTags('Social Comments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('social-comments')
export class SocialCommentsController {
  constructor(private readonly service: SocialCommentsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista comentários raiz com replies aninhadas' })
  list(
    @Query() query: ListCommentsQueryDto,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.list(orgId, access, query);
  }

  @Post(':id/reply')
  @ApiOperation({ summary: 'Responde publicamente o comentário' })
  reply(
    @Param('id') id: string,
    @Body() dto: ReplyCommentDto,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.reply(id, orgId, userId, access, dto.text);
  }

  @Patch(':id/hide')
  @ApiOperation({ summary: 'Oculta ou desoculta o comentário no Instagram' })
  hide(
    @Param('id') id: string,
    @Body() dto: HideCommentDto,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.setHidden(id, orgId, access, dto.hidden);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Deleta o comentário no Instagram (soft no banco)' })
  remove(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.remove(id, orgId, access);
  }
}
```

- [ ] **Step 6: Wiring do módulo**

`social-comments.module.ts` final:

```ts
import { Module, forwardRef } from '@nestjs/common';
import { InstagramModule } from '../channel-hub/adapters/instagram/instagram.module';
import { MessagingModule } from '../messaging/messaging.module';
import { LlmModule } from '../ai-agents/llm/llm.module';
import { SocialCommentsController } from './social-comments.controller';
import { SocialCommentsRepository } from './social-comments.repository';
import { SocialCommentsIngestService } from './social-comments-ingest.service';
import { SocialCommentsService } from './social-comments.service';

@Module({
  imports: [InstagramModule, LlmModule, forwardRef(() => MessagingModule)],
  controllers: [SocialCommentsController],
  providers: [SocialCommentsRepository, SocialCommentsIngestService, SocialCommentsService],
  exports: [SocialCommentsIngestService, SocialCommentsRepository],
})
export class SocialCommentsModule {}
```

Em `messaging.module.ts`:
- `imports`: trocar `SocialCommentsModule` por `forwardRef(() => SocialCommentsModule)`.
- `exports`: adicionar `ContactResolverService`, `ConversationResolverService`, `MessagesRepository`.

Em `inbound-message.processor.ts`: injetar com `@Inject(forwardRef(() => SocialCommentsIngestService))` (importar `Inject, forwardRef` de `@nestjs/common`).

- [ ] **Step 7: Rodar e ver passar**

Run: `npx jest src/modules/social-comments` e `npm run typecheck`
Expected: todos passam, sem erro de tipo.

- [ ] **Step 8: Commit**

```bash
git add src/modules/social-comments src/modules/messaging/messaging.module.ts src/modules/messaging/pipeline/inbound-message.processor.ts
git commit -m "feat(social-comments): listar, responder, ocultar e deletar comentarios"
```

---

## Task 7: Private reply (abrir DM com o autor)

**Files:**
- Modify: `API/src/modules/messaging/pipeline/contact-resolver.service.ts` (após `resolveManual`, ~linha 135)
- Modify: `API/src/modules/social-comments/social-comments.service.ts`
- Modify: `API/src/modules/social-comments/social-comments.service.spec.ts`
- Modify: `API/src/modules/social-comments/social-comments.controller.ts`

**Interfaces:**
- Consumes: `ContactResolverService.createContact` (privado, mesmo arquivo), `IdempotencyService.withLock`, `ConversationResolverService.resolveForOperator(orgId, channelId, contactId, senderId)`, `MessagesRepository.create(Prisma.MessageUncheckedCreateInput)`, `InstagramHttpClient.sendPrivateReply`.
- Produces:
  ```ts
  ContactResolverService.resolveByExternalId(organizationId, channelId, externalContactId, name?): Promise<ResolvedContact>
  SocialCommentsService.privateReply(id, orgId, userId, access, text): Promise<{ conversationId: string }>
  // rota: POST /social-comments/:id/private-reply  body { text }
  // 409 quando já existe DM: body { message, conversationId }
  ```

- [ ] **Step 1: Teste que falha (adicionar ao spec do service)**

Adicionar ao `build()` do spec:

```ts
  const contactResolver = { resolveByExternalId: jest.fn().mockResolvedValue({ contactId: 'ct1', contactChannelId: 'cc1', isNew: true }) };
  const conversationResolver = { resolveForOperator: jest.fn().mockResolvedValue({ conversationId: 'conv1', status: 'OPEN', isNew: true, wasReopened: false }) };
  const messagesRepo = { create: jest.fn().mockResolvedValue({ id: 'msg1' }) };
  const llm = { complete: jest.fn() };
```

e passar `contactResolver, conversationResolver, messagesRepo, llm` nas 4 últimas posições do construtor (no lugar dos `{} as any`). Também adicionar `http.sendPrivateReply = jest.fn().mockResolvedValue({ recipient_id: '5550001', message_id: 'mid1' })`, `prisma.conversation = { update: jest.fn().mockResolvedValue({}) }`, `realtime.emitToConversation = jest.fn()` e retornar tudo do `build()`.

Novo bloco:

```ts
  describe('privateReply', () => {
    it('envia DM, cria contato/conversa/mensagem e grava conversationId', async () => {
      const { service, http, contactResolver, conversationResolver, messagesRepo, repo, realtime } = build();

      const out = await service.privateReply('s1', 'org1', 'u1', 'ALL', 'Oi Maria, te chamei no direct');

      expect(http.sendPrivateReply).toHaveBeenCalledWith(channel, 'c1', 'Oi Maria, te chamei no direct');
      expect(contactResolver.resolveByExternalId).toHaveBeenCalledWith('org1', 'ch1', '5550001', 'maria.s');
      expect(conversationResolver.resolveForOperator).toHaveBeenCalledWith('org1', 'ch1', 'ct1', 'u1');
      expect(messagesRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: 'conv1', direction: 'OUTBOUND', type: 'TEXT', status: 'SENT',
        externalId: 'mid1', senderId: 'u1', content: { text: 'Oi Maria, te chamei no direct' },
      }));
      expect(repo.update).toHaveBeenCalledWith('s1', { privateReplyConversationId: 'conv1' });
      expect(realtime.emitToChannel).toHaveBeenCalledWith('ch1', 'message:new', expect.objectContaining({ conversationId: 'conv1' }));
      expect(out).toEqual({ conversationId: 'conv1' });
    });

    it('segunda tentativa: 409 com conversationId', async () => {
      const { service, repo, http } = build();
      repo.findById.mockResolvedValue({ ...root, privateReplyConversationId: 'conv0' });
      await expect(service.privateReply('s1', 'org1', 'u1', 'ALL', 'x')).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ conversationId: 'conv0' }),
      });
      expect(http.sendPrivateReply).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest src/modules/social-comments/social-comments.service.spec.ts -t privateReply`
Expected: FAIL, `service.privateReply is not a function`.

- [ ] **Step 3: `resolveByExternalId` no ContactResolver**

Após `resolveManual`:

```ts
  /**
   * Resolve/cria contato a partir do id externo do provider (ex.: IGSID de
   * quem comentou num post). Usado pelo private reply de comentários, onde
   * não há telefone nem email — só o id do Instagram.
   */
  async resolveByExternalId(
    organizationId: string,
    channelId: string,
    externalContactId: string,
    name?: string,
  ): Promise<ResolvedContact> {
    const find = () =>
      this.prisma.contactChannel.findUnique({
        where: { uq_contact_channel_external: { channelId, externalId: externalContactId } },
      });

    const existing = await find();
    if (existing) {
      return { contactId: existing.contactId, contactChannelId: existing.id, isNew: false };
    }

    return this.idempotency.withLock(
      `contact:${channelId}:${externalContactId}`,
      async () => {
        const racer = await find();
        if (racer) {
          return { contactId: racer.contactId, contactChannelId: racer.id, isNew: false };
        }
        return this.createContact(organizationId, channelId, { externalContactId, name });
      },
    );
  }
```

- [ ] **Step 4: `privateReply` no service**

Imports extras: `ConflictException` de `@nestjs/common`; `MessageDirection, MessageContentType, MessageStatus` de `@prisma/client`.

```ts
  async privateReply(id: string, orgId: string, userId: string, access: ChannelAccess, text: string) {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    if (comment.privateReplyConversationId) {
      throw new ConflictException({
        message: 'DM já aberta para este comentário',
        conversationId: comment.privateReplyConversationId,
      });
    }

    const sent = await this.graph(() =>
      this.instagram.sendPrivateReply(channel, comment.externalId, text),
    );

    const { contactId } = await this.contactResolver.resolveByExternalId(
      orgId,
      channel.id,
      comment.authorExternalId,
      comment.authorUsername ?? undefined,
    );
    const { conversationId } = await this.conversationResolver.resolveForOperator(
      orgId,
      channel.id,
      contactId,
      userId,
    );

    const message = await this.messagesRepo.create({
      conversationId,
      direction: MessageDirection.OUTBOUND,
      type: MessageContentType.TEXT,
      content: { text },
      status: MessageStatus.SENT,
      externalId: sent?.message_id ?? null,
      senderId: userId,
      sentAt: new Date(),
      metadata: { privateReplyOf: comment.externalId },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });
    this.realtime.emitToChannel(channel.id, 'message:new', { message, conversationId, contactId });
    this.realtime.emitToConversation(conversationId, 'message:new', { message });

    await this.repo.update(id, { privateReplyConversationId: conversationId });
    await this.emitThread(channel.id, comment.parentExternalId ?? comment.externalId);
    return { conversationId };
  }
```

- [ ] **Step 5: Rota no controller**

```ts
  @Post(':id/private-reply')
  @ApiOperation({ summary: 'Abre DM com o autor do comentário (Private Reply)' })
  privateReply(
    @Param('id') id: string,
    @Body() dto: ReplyCommentDto,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.privateReply(id, orgId, userId, access, dto.text);
  }
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx jest src/modules/social-comments` e `npm run typecheck`
Expected: todos passam.

- [ ] **Step 7: Commit**

```bash
git add src/modules/messaging/pipeline/contact-resolver.service.ts src/modules/social-comments
git commit -m "feat(social-comments): private reply abre DM com o autor do comentario"
```

---

## Task 8: Sugestão de resposta com IA

**Files:**
- Modify: `API/src/modules/social-comments/social-comments.service.ts`
- Modify: `API/src/modules/social-comments/social-comments.service.spec.ts`
- Modify: `API/src/modules/social-comments/social-comments.controller.ts`

**Interfaces:**
- Consumes: `LlmService.complete({ modelId, messages, temperature, maxTokens })` retornando `{ message: { content: string | Part[] } }`; `SAKANA_CONVERSATION_MODEL` de `../ai-agents/llm/llm.constants`; `organization.aiBusinessNotes`.
- Produces: `suggest(id, orgId, access): Promise<{ text: string; reason?: 'spam' }>`; rota `POST /social-comments/:id/suggest`.

- [ ] **Step 1: Teste que falha**

No spec, `prisma.organization = { findUnique: jest.fn().mockResolvedValue({ name: 'Loja X', aiBusinessNotes: 'Vendemos cursos.' }) }`. Bloco:

```ts
  describe('suggest', () => {
    it('monta prompt com legenda + comentário e devolve texto', async () => {
      const { service, repo, llm } = build();
      repo.findById.mockResolvedValue({ ...root, mediaCaption: 'Promoção de setembro' });
      repo.findThread.mockResolvedValue({ ...root, mediaCaption: 'Promoção de setembro', replies: [] });
      llm.complete.mockResolvedValue({ message: { role: 'assistant', content: 'Oi Maria! Custa R$ 99, te chamo no direct.' } });

      const out = await service.suggest('s1', 'org1', 'ALL');

      const req = llm.complete.mock.calls[0][0];
      expect(req.modelId).toBe('sakana/fugu-ultra-20260615');
      expect(req.messages[0].role).toBe('system');
      expect(req.messages[0].content).toContain('Vendemos cursos.');
      expect(req.messages[1].content).toContain('Promoção de setembro');
      expect(req.messages[1].content).toContain('Quanto custa?');
      expect(out).toEqual({ text: 'Oi Maria! Custa R$ 99, te chamo no direct.' });
    });

    it('modelo devolve [SPAM]: texto vazio com reason', async () => {
      const { service, llm } = build();
      llm.complete.mockResolvedValue({ message: { role: 'assistant', content: '[SPAM]' } });
      await expect(service.suggest('s1', 'org1', 'ALL')).resolves.toEqual({ text: '', reason: 'spam' });
    });
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest src/modules/social-comments/social-comments.service.spec.ts -t suggest`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Import: `import { SAKANA_CONVERSATION_MODEL } from '../ai-agents/llm/llm.constants';`

```ts
  async suggest(id: string, orgId: string, access: ChannelAccess): Promise<{ text: string; reason?: 'spam' }> {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    const thread = await this.repo.findThread(channel.id, comment.parentExternalId ?? comment.externalId);
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true, aiBusinessNotes: true },
    });

    const system = [
      `Você responde comentários públicos no Instagram da conta "${channel.name}" (${org?.name ?? ''}).`,
      'Regras: responda em português do Brasil, tom cordial e direto, no máximo 2 frases.',
      'Não invente preços, prazos ou promoções que não estejam no contexto. Não inclua links.',
      'Se o comentário for spam, ofensivo ou não merecer resposta, responda exatamente: [SPAM]',
      org?.aiBusinessNotes?.trim() ? `\nSobre a empresa:\n${org.aiBusinessNotes.trim()}` : '',
    ].filter(Boolean).join('\n');

    const replies = (thread?.replies ?? [])
      .map((r) => `- ${r.isFromPage ? 'Página' : `@${r.authorUsername ?? r.authorExternalId}`}: ${r.text}`)
      .join('\n');
    const user = [
      `Legenda do post: ${thread?.mediaCaption ?? comment.mediaCaption ?? '(sem legenda)'}`,
      `Comentário de @${comment.authorUsername ?? comment.authorExternalId}: ${comment.text}`,
      replies ? `Respostas anteriores na thread:\n${replies}` : '',
      'Escreva só o texto da resposta.',
    ].filter(Boolean).join('\n\n');

    const resp = await this.llm.complete({
      modelId: SAKANA_CONVERSATION_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.5,
      maxTokens: 200,
    });

    const raw = typeof resp.message.content === 'string'
      ? resp.message.content
      : resp.message.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
    const text = raw.trim();
    if (!text || text.toUpperCase().includes('[SPAM]')) return { text: '', reason: 'spam' };
    return { text };
  }
```

Se `LlmMessage.role`/`content` tiverem tipos mais estritos que `string`, ajustar conforme `llm.types.ts` (`content` aceita `string | LlmContentPart[]`).

- [ ] **Step 4: Rota**

```ts
  @Post(':id/suggest')
  @ApiOperation({ summary: 'Sugere resposta com IA (não envia)' })
  suggest(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.suggest(id, orgId, access);
  }
```

- [ ] **Step 5: Rodar tudo do backend**

Run: `npx jest` e `npm run typecheck`
Expected: suíte inteira verde.

- [ ] **Step 6: Commit**

```bash
git add src/modules/social-comments
git commit -m "feat(social-comments): sugestao de resposta com IA"
```

---

## Task 9: Front — service, tipos e hooks

**Files:**
- Create: `WEB/src/features/comments/services/comments.service.ts`
- Create: `WEB/src/features/comments/hooks/use-comments.ts`
- Create: `WEB/src/features/comments/hooks/use-comments-socket.ts`

**Interfaces:**
- Consumes: rotas da API (Tasks 6-8), `api` de `@/lib/api`, `useOrgId`, `useSocket().on`.
- Produces:
  ```ts
  type SocialCommentStatus = 'VISIBLE' | 'HIDDEN' | 'DELETED';
  interface SocialComment { id; channelId; externalId; parentExternalId: string | null; mediaId; mediaPermalink: string | null; mediaCaption: string | null; mediaThumbnailUrl: string | null; authorExternalId; authorUsername: string | null; text; status: SocialCommentStatus; isFromPage: boolean; repliedAt: string | null; privateReplyConversationId: string | null; commentedAt: string; replies: SocialComment[] }
  interface CommentsFilters { channelId?: string; status?: SocialCommentStatus; unreplied?: boolean }
  commentsService.list(filters, cursor?) => Promise<{ items: SocialComment[]; nextCursor: string | null }>
  commentsService.reply(id, text) / hide(id, hidden) / remove(id) => Promise<SocialComment>
  commentsService.privateReply(id, text) => Promise<{ conversationId: string }>
  commentsService.suggest(id) => Promise<{ text: string; reason?: 'spam' }>
  useComments(filters) => useInfiniteQuery result; query key ['social-comments', orgId, filters]
  useCommentsSocket() => void
  ```

- [ ] **Step 1: Service**

```ts
// comments.service.ts
import { api } from '@/lib/api';

export type SocialCommentStatus = 'VISIBLE' | 'HIDDEN' | 'DELETED';

export interface SocialComment {
  id: string;
  channelId: string;
  externalId: string;
  parentExternalId: string | null;
  mediaId: string;
  mediaPermalink: string | null;
  mediaCaption: string | null;
  mediaThumbnailUrl: string | null;
  authorExternalId: string;
  authorUsername: string | null;
  text: string;
  status: SocialCommentStatus;
  isFromPage: boolean;
  repliedAt: string | null;
  privateReplyConversationId: string | null;
  commentedAt: string;
  replies: SocialComment[];
}

export interface CommentsFilters {
  channelId?: string;
  status?: SocialCommentStatus;
  unreplied?: boolean;
}

export interface CommentsPage {
  items: SocialComment[];
  nextCursor: string | null;
}

export const commentsService = {
  async list(filters: CommentsFilters, cursor?: string): Promise<CommentsPage> {
    const params: Record<string, string> = { limit: '30' };
    if (filters.channelId) params.channelId = filters.channelId;
    if (filters.status) params.status = filters.status;
    if (filters.unreplied) params.unreplied = 'true';
    if (cursor) params.cursor = cursor;
    const { data } = await api.get('/social-comments', { params });
    return data.data;
  },
  async reply(id: string, text: string): Promise<SocialComment> {
    const { data } = await api.post(`/social-comments/${id}/reply`, { text });
    return data.data;
  },
  async hide(id: string, hidden: boolean): Promise<SocialComment> {
    const { data } = await api.patch(`/social-comments/${id}/hide`, { hidden });
    return data.data;
  },
  async remove(id: string): Promise<SocialComment> {
    const { data } = await api.delete(`/social-comments/${id}`);
    return data.data;
  },
  async privateReply(id: string, text: string): Promise<{ conversationId: string }> {
    const { data } = await api.post(`/social-comments/${id}/private-reply`, { text });
    return data.data;
  },
  async suggest(id: string): Promise<{ text: string; reason?: 'spam' }> {
    const { data } = await api.post(`/social-comments/${id}/suggest`);
    return data.data;
  },
};
```

Nota: o interceptor de `api.ts` transforma erro em `Error(message)` e perde o body. Para o 409 do private reply, o dialog (Task 12) precisa do `conversationId`. Tratar assim no service:

```ts
  async privateReply(id: string, text: string): Promise<{ conversationId: string }> {
    try {
      const { data } = await api.post(`/social-comments/${id}/private-reply`, { text });
      return data.data;
    } catch (err: any) {
      throw err;
    }
  },
```

e no `api.ts`, no `interceptors.response.use`, preservar o body: antes de `return Promise.reject(new Error(...))` adicionar:

```ts
    const wrapped = new Error(Array.isArray(message) ? message[0] : message) as Error & { status?: number; body?: any };
    wrapped.status = error.response?.status;
    wrapped.body = error.response?.data;
    return Promise.reject(wrapped);
```

substituindo o `return Promise.reject(new Error(...))` atual. Isso não muda o `.message` que os outros consumidores já leem.

- [ ] **Step 2: Hook da lista**

```ts
// use-comments.ts
'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useOrgId } from '@/hooks/use-org-query-key';
import { commentsService, type CommentsFilters } from '../services/comments.service';

export const COMMENTS_QUERY_KEY = 'social-comments';

export function useComments(filters: CommentsFilters) {
  const orgId = useOrgId();
  return useInfiniteQuery({
    queryKey: [COMMENTS_QUERY_KEY, orgId, filters],
    queryFn: ({ pageParam }) => commentsService.list(filters, pageParam ?? undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!orgId,
  });
}
```

- [ ] **Step 3: Hook do socket**

```ts
// use-comments-socket.ts
'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSocket } from '@/features/inbox/hooks/use-socket';
import { COMMENTS_QUERY_KEY } from './use-comments';

/** Invalida a lista quando o backend emite eventos de comentário no canal. */
export function useCommentsSocket() {
  const { on, onReconnect } = useSocket();
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = () =>
      queryClient.invalidateQueries({ queryKey: [COMMENTS_QUERY_KEY] });
    const offNew = on('comment:new', invalidate);
    const offUpdated = on('comment:updated', invalidate);
    const offReconnect = onReconnect(invalidate);
    return () => {
      offNew();
      offUpdated();
      offReconnect();
    };
  }, [on, onReconnect, queryClient]);
}
```

- [ ] **Step 4: Verificar**

Run (em `WEB`): `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 5: Commit**

```bash
git add src/features/comments src/lib/api.ts
git commit -m "feat(comments): service, tipos e hooks da central de comentarios"
```

---

## Task 10: Front — rota, sidebar, filtros e lista (somente leitura)

**Files:**
- Create: `WEB/src/features/comments/components/comments-filters.tsx`
- Create: `WEB/src/features/comments/components/comment-card.tsx`
- Create: `WEB/src/features/comments/components/comment-list.tsx`
- Create: `WEB/src/app/(dashboard)/comments/page.tsx`
- Modify: `WEB/src/components/layout/app-sidebar.tsx:3-13, 38-42`

**Interfaces:**
- Consumes: `useComments`, `useCommentsSocket`, `channelsService.list()`, tipos de Task 9.
- Produces:
  ```tsx
  <CommentsFilters channels={Channel[]} value={CommentsFilters & { view: 'all' | 'unreplied' | 'hidden' | 'deleted' }} onChange={...} />
  <CommentCard comment={SocialComment} />   // nesta task sem ações; Task 11 adiciona
  <CommentList />                            // página inteira
  ```

- [ ] **Step 1: Filtros**

```tsx
// comments-filters.tsx
'use client';

import type { Channel } from '@/features/channels/services/channels.service';

export type CommentsView = 'all' | 'unreplied' | 'hidden' | 'deleted';

export interface CommentsFilterState {
  channelId: string;
  view: CommentsView;
}

const controlCls =
  'h-9 rounded-md border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

interface Props {
  channels: Channel[];
  value: CommentsFilterState;
  onChange: (next: CommentsFilterState) => void;
}

export function CommentsFilters({ channels, value, onChange }: Props) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <select
        className={controlCls}
        value={value.channelId}
        onChange={(e) => onChange({ ...value, channelId: e.target.value })}
      >
        <option value="">Todas as contas</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <select
        className={controlCls}
        value={value.view}
        onChange={(e) => onChange({ ...value, view: e.target.value as CommentsView })}
      >
        <option value="all">Todos</option>
        <option value="unreplied">Sem resposta</option>
        <option value="hidden">Ocultos</option>
        <option value="deleted">Deletados</option>
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Card (somente leitura nesta task)**

```tsx
// comment-card.tsx
'use client';

import { ExternalLink, EyeOff, Trash2, ImageOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SocialComment } from '../services/comments.service';

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

function StatusBadge({ status }: { status: SocialComment['status'] }) {
  if (status === 'VISIBLE') return null;
  const hidden = status === 'HIDDEN';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        hidden
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
          : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
      )}
    >
      {hidden ? <EyeOff className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
      {hidden ? 'Oculto' : 'Deletado'}
    </span>
  );
}

interface Props {
  comment: SocialComment;
  /** Slot para ações e caixa de resposta (Task 11). */
  children?: React.ReactNode;
}

export function CommentCard({ comment, children }: Props) {
  const deleted = comment.status === 'DELETED';
  return (
    <article
      className={cn(
        'rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900',
        deleted && 'opacity-60',
      )}
    >
      <div className="flex gap-3">
        <a
          href={comment.mediaPermalink ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800"
          title={comment.mediaCaption ?? 'Post'}
        >
          {comment.mediaThumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={comment.mediaThumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageOff className="h-5 w-5 text-zinc-400" />
          )}
        </a>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              @{comment.authorUsername ?? comment.authorExternalId}
            </span>
            <span className="text-xs text-zinc-400">{relativeTime(comment.commentedAt)}</span>
            <StatusBadge status={comment.status} />
            {comment.repliedAt && comment.status === 'VISIBLE' && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                Respondido
              </span>
            )}
            {comment.mediaPermalink && (
              <a
                href={comment.mediaPermalink}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-primary"
              >
                Ver post <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          {comment.mediaCaption && (
            <p className="mt-0.5 line-clamp-1 text-xs text-zinc-400">{comment.mediaCaption}</p>
          )}
          <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">
            {comment.text}
          </p>

          {comment.replies.length > 0 && (
            <ul className="mt-3 space-y-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
              {comment.replies.map((r) => (
                <li key={r.id} className={cn('text-sm', r.status === 'DELETED' && 'line-through opacity-60')}>
                  <span className={cn('font-medium', r.isFromPage ? 'text-primary' : 'text-zinc-700 dark:text-zinc-300')}>
                    {r.isFromPage ? 'Você' : `@${r.authorUsername ?? r.authorExternalId}`}
                  </span>
                  <span className="ml-1 text-xs text-zinc-400">{relativeTime(r.commentedAt)}</span>
                  <StatusBadge status={r.status} />
                  <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{r.text}</p>
                </li>
              ))}
            </ul>
          )}

          {children}
        </div>
      </div>
    </article>
  );
}
```

- [ ] **Step 3: Lista (página)**

```tsx
// comment-list.tsx
'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquareText, Loader2 } from 'lucide-react';
import { useOrgId } from '@/hooks/use-org-query-key';
import { channelsService } from '@/features/channels/services/channels.service';
import { useComments } from '../hooks/use-comments';
import { useCommentsSocket } from '../hooks/use-comments-socket';
import type { CommentsFilters as ApiFilters } from '../services/comments.service';
import { CommentsFilters, type CommentsFilterState } from './comments-filters';
import { CommentCard } from './comment-card';

function toApiFilters(state: CommentsFilterState): ApiFilters {
  const f: ApiFilters = {};
  if (state.channelId) f.channelId = state.channelId;
  if (state.view === 'unreplied') f.unreplied = true;
  if (state.view === 'hidden') f.status = 'HIDDEN';
  if (state.view === 'deleted') f.status = 'DELETED';
  return f;
}

export function CommentList() {
  const orgId = useOrgId();
  const [filters, setFilters] = useState<CommentsFilterState>({ channelId: '', view: 'all' });
  useCommentsSocket();

  const { data: channels = [] } = useQuery({
    queryKey: ['channels', orgId],
    queryFn: () => channelsService.list(),
    staleTime: 60_000,
  });
  const igChannels = useMemo(() => channels.filter((c) => c.type === 'INSTAGRAM'), [channels]);

  const apiFilters = useMemo(() => toApiFilters(filters), [filters]);
  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = useComments(apiFilters);
  const items = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <div className="flex items-center gap-2">
        <MessageSquareText className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Comentários</h1>
      </div>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Comentários públicos nos posts das contas Instagram conectadas.
      </p>

      <CommentsFilters channels={igChannels} value={filters} onChange={setFilters} />

      {isLoading ? (
        <div className="mt-10 flex justify-center text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nenhum comentário por aqui.</p>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Se a conta acabou de ser conectada, confira se o token tem a permissão
            <code className="mx-1">instagram_business_manage_comments</code>
            e se o app Meta assina o webhook <code>comments</code>. Só comentários feitos depois disso aparecem aqui.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {items.map((c) => (
            <CommentCard key={c.id} comment={c} />
          ))}
          {hasNextPage && (
            <button
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="mx-auto block rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Rota e sidebar**

```tsx
// src/app/(dashboard)/comments/page.tsx
'use client';

import { CommentList } from '@/features/comments/components/comment-list';

export default function CommentsPage() {
  return <CommentList />;
}
```

Em `app-sidebar.tsx`: adicionar `MessageSquareText` ao import de `lucide-react` e em `navItems` inserir entre Dashboard e Projetos:

```ts
  { href: '/comments', label: 'Comentários', icon: MessageSquareText },
```

- [ ] **Step 5: Verificar**

Run: `npx tsc --noEmit` e `npm run lint`
Expected: sem erros. Com API rodando: abrir `/comments`, ver lista ou empty state; filtros trocam a query.

- [ ] **Step 6: Commit**

```bash
git add src/features/comments src/app/\(dashboard\)/comments src/components/layout/app-sidebar.tsx
git commit -m "feat(comments): tela de comentarios com filtros e lista"
```

---

## Task 11: Front — responder, ocultar, deletar e sugerir com IA

**Files:**
- Create: `WEB/src/features/comments/components/comment-reply-box.tsx`
- Modify: `WEB/src/features/comments/components/comment-card.tsx` (props de ações)
- Modify: `WEB/src/features/comments/components/comment-list.tsx` (mutations)

**Interfaces:**
- Consumes: `commentsService.reply/hide/remove/suggest`, `useAuthStore` (role para esconder Deletar de AGENT), `toast` de `sonner`.
- Produces:
  ```tsx
  <CommentReplyBox commentId onReply={(text) => Promise<void>} onSuggest={() => Promise<{ text; reason? }>} />
  CommentCard props extras: onHide?: (hidden: boolean) => void; onDelete?: () => void; canDelete?: boolean; children (reply box)
  ```

- [ ] **Step 1: Caixa de resposta**

```tsx
// comment-reply-box.tsx
'use client';

import { useState } from 'react';
import { Sparkles, Send, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  onReply: (text: string) => Promise<void>;
  onSuggest: () => Promise<{ text: string; reason?: 'spam' }>;
}

export function CommentReplyBox({ onReply, onSuggest }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const handleSuggest = async () => {
    setSuggesting(true);
    try {
      const out = await onSuggest();
      if (out.reason === 'spam') {
        toast.info('A IA achou que esse comentário não merece resposta.');
        return;
      }
      setText(out.text);
    } catch (err: any) {
      toast.error(err.message ?? 'Não foi possível sugerir');
    } finally {
      setSuggesting(false);
    }
  };

  const handleSend = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    try {
      await onReply(value);
      setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={2200}
        placeholder="Responder publicamente…"
        className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleSuggest}
          disabled={suggesting || sending}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {suggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Sugerir com IA
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={sending || !text.trim()}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Responder
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Ações no card**

Em `comment-card.tsx`, adicionar às props:

```ts
  onHide?: (hidden: boolean) => void;
  onDelete?: () => void;
  canDelete?: boolean;
  busy?: boolean;
```

e, logo após o `<p>` do texto do comentário (antes da lista de replies), renderizar a barra de ações quando `!deleted`:

```tsx
          {!deleted && (
            <div className="mt-2 flex items-center gap-3 text-xs">
              {onHide && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onHide(comment.status !== 'HIDDEN')}
                  className="inline-flex items-center gap-1 text-zinc-500 hover:text-amber-600 disabled:opacity-50"
                >
                  {comment.status === 'HIDDEN' ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  {comment.status === 'HIDDEN' ? 'Desocultar' : 'Ocultar'}
                </button>
              )}
              {canDelete && onDelete && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Deletar este comentário no Instagram? Não dá pra desfazer.')) onDelete();
                  }}
                  className="inline-flex items-center gap-1 text-zinc-500 hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Deletar
                </button>
              )}
            </div>
          )}
```

Adicionar `Eye` ao import de `lucide-react`. `children` (reply box) só renderiza quando `!deleted`: trocar `{children}` por `{!deleted && children}`.

- [ ] **Step 3: Mutations na lista**

Em `comment-list.tsx`, imports extras:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth-store';
import { commentsService } from '../services/comments.service';
import { COMMENTS_QUERY_KEY } from '../hooks/use-comments';
import { CommentReplyBox } from './comment-reply-box';
```

Dentro do componente:

```tsx
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.organizations.find((o) => o.id === s.activeOrgId)?.role);
  const canDelete = role === 'OWNER' || role === 'ADMIN';
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [COMMENTS_QUERY_KEY] });

  const replyMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => commentsService.reply(id, text),
    onSuccess: () => { toast.success('Resposta publicada'); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const hideMutation = useMutation({
    mutationFn: ({ id, hidden }: { id: string; hidden: boolean }) => commentsService.hide(id, hidden),
    onSuccess: (_d, v) => { toast.success(v.hidden ? 'Comentário oculto' : 'Comentário visível'); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => commentsService.remove(id),
    onSuccess: () => { toast.success('Comentário deletado'); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const busyId = replyMutation.isPending ? replyMutation.variables?.id
    : hideMutation.isPending ? hideMutation.variables?.id
    : deleteMutation.isPending ? deleteMutation.variables
    : undefined;
```

E o render do card vira:

```tsx
          {items.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              busy={busyId === c.id}
              canDelete={canDelete}
              onHide={(hidden) => hideMutation.mutate({ id: c.id, hidden })}
              onDelete={() => deleteMutation.mutate(c.id)}
            >
              <CommentReplyBox
                onReply={(text) => replyMutation.mutateAsync({ id: c.id, text }).then(() => undefined)}
                onSuggest={() => commentsService.suggest(c.id)}
              />
            </CommentCard>
          ))}
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit` e `npm run lint`
Expected: sem erros. Manual com API: responder publica e some do filtro "Sem resposta"; ocultar muda badge; deletar pede confirmação e esmaece o card; "Sugerir com IA" preenche a textarea.

- [ ] **Step 5: Commit**

```bash
git add src/features/comments
git commit -m "feat(comments): responder, ocultar, deletar e sugestao com IA"
```

---

## Task 12: Front — dialog de DM (private reply)

**Files:**
- Create: `WEB/src/features/comments/components/private-reply-dialog.tsx`
- Modify: `WEB/src/features/comments/components/comment-card.tsx` (botão "Abrir DM" / "Ver DM")
- Modify: `WEB/src/features/comments/components/comment-list.tsx` (estado do dialog)

**Interfaces:**
- Consumes: `commentsService.privateReply(id, text)`; erro com `status === 409` e `body.conversationId` (Task 9 ajustou `api.ts`); `useRouter().push('/inbox?conversationId=...')`.
- Produces: `<PrivateReplyDialog open comment onClose />`; `CommentCard` prop `onOpenDm?: () => void`.

- [ ] **Step 1: Dialog**

```tsx
// private-reply-dialog.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { X, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { commentsService, type SocialComment } from '../services/comments.service';
import { COMMENTS_QUERY_KEY } from '../hooks/use-comments';

interface Props {
  open: boolean;
  comment: SocialComment | null;
  onClose: () => void;
}

export function PrivateReplyDialog({ open, comment, onClose }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  if (!open || !comment) return null;

  const goToInbox = (conversationId: string) => {
    onClose();
    setText('');
    router.push(`/inbox?conversationId=${conversationId}`);
  };

  const handleSend = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    try {
      const { conversationId } = await commentsService.privateReply(comment.id, value);
      queryClient.invalidateQueries({ queryKey: [COMMENTS_QUERY_KEY] });
      toast.success('DM enviada');
      goToInbox(conversationId);
    } catch (err: any) {
      if (err?.status === 409 && err?.body?.conversationId) {
        toast.info('Já existe uma DM aberta com esse contato.');
        goToInbox(err.body.conversationId);
        return;
      }
      toast.error(err?.message ?? 'Não foi possível enviar a DM');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Abrir DM com @{comment.authorUsername ?? comment.authorExternalId}
          </h3>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-6 py-5">
          <p className="rounded-md bg-zinc-50 p-3 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            “{comment.text}”
          </p>
          <p className="text-xs text-zinc-500">
            O Instagram permite uma mensagem direta por comentário, até 7 dias depois dele. A conversa continua no Inbox.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Oi! Vi seu comentário e…"
            className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Cancelar
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !text.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Enviar DM
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Botão no card**

Em `comment-card.tsx`, prop `onOpenDm?: () => void` e, na barra de ações (antes de Ocultar), quando o comentário não é da página:

```tsx
              {!comment.isFromPage && (
                comment.privateReplyConversationId ? (
                  <Link
                    href={`/inbox?conversationId=${comment.privateReplyConversationId}`}
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <MessageCircle className="h-3.5 w-3.5" /> Ver DM
                  </Link>
                ) : onOpenDm ? (
                  <button type="button" disabled={busy} onClick={onOpenDm} className="inline-flex items-center gap-1 text-zinc-500 hover:text-primary disabled:opacity-50">
                    <MessageCircle className="h-3.5 w-3.5" /> Abrir DM
                  </button>
                ) : null
              )}
```

Imports: `Link` de `next/link`, `MessageCircle` de `lucide-react`.

- [ ] **Step 3: Estado na lista**

Em `comment-list.tsx`:

```tsx
import { PrivateReplyDialog } from './private-reply-dialog';
import type { SocialComment } from '../services/comments.service';
// ...
  const [dmTarget, setDmTarget] = useState<SocialComment | null>(null);
```

Passar `onOpenDm={() => setDmTarget(c)}` ao `CommentCard` e, antes do fechamento do `div` raiz:

```tsx
      <PrivateReplyDialog open={!!dmTarget} comment={dmTarget} onClose={() => setDmTarget(null)} />
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit` e `npm run lint`
Expected: sem erros. Manual: "Abrir DM" abre modal, enviar navega para o inbox na conversa criada; segunda tentativa no mesmo comentário mostra "Ver DM".

- [ ] **Step 5: Commit**

```bash
git add src/features/comments
git commit -m "feat(comments): abrir DM com o autor via private reply"
```

---

## Validação final (manual, com API + Redis + banco)

1. Regenerar token do canal Instagram com `instagram_business_manage_comments` e assinar o campo `comments` no app Meta.
2. Comentar num post da conta. Verificar: linha em `social_comments`, `comment:new` no socket, card aparece em `/comments` sem F5.
3. Responder pela tela: reply aparece no IG, thread atualiza, card sai de "Sem resposta".
4. Responder pelo app do Instagram: webhook chega com `from.id` = conta, `isFromPage=true`, pai marcado como respondido.
5. Ocultar/desocultar e deletar refletem no IG.
6. Abrir DM: mensagem chega no Direct do autor, conversa aparece no Inbox com a mensagem outbound.
7. Sugerir com IA preenche a caixa; comentário tipo "🔥🔥🔥" retorna aviso de spam.
