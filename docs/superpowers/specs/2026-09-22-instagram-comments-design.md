# Central de Comentários do Instagram — Design

**Data:** 2026-09-22
**Repos:** `chat-bullq-api` (backend) e `chat-bullq-web` (frontend)
**Status:** aprovado em conversa, aguardando plano de implementação

## 1. Objetivo

Criar uma área única onde a equipe vê todos os comentários públicos feitos nos
posts das contas Instagram conectadas e age sobre eles sem sair do sistema:
responder publicamente, ocultar/desocultar, deletar, abrir DM com o autor e
pedir uma sugestão de resposta à IA.

### Fora de escopo (v1)

- Comentários de páginas do Facebook (não existe canal Facebook; exigiria novo `ChannelType`).
- Backfill de comentários anteriores à assinatura do webhook. Só entram comentários
  recebidos por webhook a partir da ativação. Sync de posts antigos é um próximo passo.
- Estado interno de "lido/resolvido". A triagem usa o filtro "sem resposta".
- Curtir comentário, menções em stories, comentários em anúncios (ads).

## 2. Pré-requisitos externos (Meta)

Sem isso nada funciona e não é código:

1. Token de cada canal Instagram precisa do scope `instagram_business_manage_comments`.
   Tokens já cadastrados precisam ser regenerados com o scope novo.
2. O app Meta precisa assinar o campo de webhook `comments` (hoje só `messages`).
3. Private Reply (`recipient.comment_id`) exige que a conta tenha DM habilitada e só
   funciona até 7 dias após o comentário.

A tela deve mostrar um aviso quando o canal Instagram ainda não recebeu nenhum
comentário, orientando a verificar os dois primeiros itens.

## 3. Backend (`chat-bullq-api`)

### 3.1 Model Prisma

```prisma
enum SocialCommentStatus {
  VISIBLE
  HIDDEN
  DELETED
}

model SocialComment {
  id                         String              @id @default(cuid())
  organizationId             String              @map("organization_id")
  channelId                  String              @map("channel_id")
  externalId                 String              @map("external_id")          // comment id no IG
  parentExternalId           String?             @map("parent_external_id")   // null = comentário raiz
  mediaId                    String              @map("media_id")
  mediaPermalink             String?             @map("media_permalink")
  mediaCaption               String?             @map("media_caption") @db.Text
  mediaThumbnailUrl          String?             @map("media_thumbnail_url")
  authorExternalId           String              @map("author_external_id")   // IGSID de quem comentou
  authorUsername             String?             @map("author_username")
  text                       String              @db.Text
  status                     SocialCommentStatus @default(VISIBLE)
  isFromPage                 Boolean             @default(false) @map("is_from_page") // reply da própria conta
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
  @@index([channelId, parentExternalId], name: "idx_social_comment_thread")
  @@map("social_comments")
}
```

`repliedAt` é setado no comentário raiz quando a página responde (via sistema ou
quando chega webhook de reply cuja `from.id` é a própria conta). Filtro "sem
resposta" = `parentExternalId IS NULL AND repliedAt IS NULL AND status = VISIBLE`.

### 3.2 Ingestão via webhook

Payload do IG para comentários chega em `entry[].changes[]` com
`field: "comments"` e `value: { id, text, from: { id, username }, media: { id, media_product_type }, parent_id? }`.

Mudanças:

- `ports/types`: novo `NormalizedComment` e campo opcional `comments?: NormalizedComment[]`
  em `WebhookParseResult`. Adapters existentes não precisam mudar.
- `InstagramInboundAdapter.parseWebhook`: além de `entry[].messaging`, percorre
  `entry[].changes` com `field === 'comments'` e produz `NormalizedComment`.
  Mantém o scoping estrito por `entry.id` já existente.
- `InstagramMessageMapper.normalizeComment(value, entryTime)`: função pura, testável.
- `WebhookGatewayController`: para cada `parseResult.comments`, enfileira job
  `process-comment` na fila existente `inbound-messages` (mesmas opções de retry
  do `process-inbound`). Não cria fila nova.
- A fila `inbound-messages` já tem um único consumer (`InboundMessageProcessor`)
  que faz switch por `job.name`. Ele delega `job.name === 'process-comment'` para
  `SocialCommentsService.ingest()`. Não se cria segundo `@Processor` na mesma fila.

`ingest(channelId, organizationId, comment)`:

1. Upsert por `(channelId, externalId)`. Reprocessamento do mesmo webhook é idempotente.
2. `isFromPage = comment.authorExternalId === config.igBusinessId`.
3. Se `isFromPage` e tem `parentExternalId`: marca `repliedAt` no pai (se ainda null).
4. Enriquecimento de mídia: se nenhum comentário com o mesmo `mediaId` já tem
   `mediaPermalink`, chama `InstagramHttpClient.getMedia(channel, mediaId)`
   (`fields=permalink,caption,media_type,thumbnail_url,media_url`) e grava. Se já
   existe, copia dos irmãos. Falha no enriquecimento não derruba o job: loga e segue.
5. Emite `comment:new` via `RealtimeGateway.emitToChannel(channelId, ...)` só para
   comentários que não são `isFromPage`. Replies da página emitem `comment:updated`
   com o pai.

### 3.3 `InstagramHttpClient` — métodos novos

Todos em `graph.instagram.com/{version}` com o token do canal:

| Método | Chamada Graph |
|---|---|
| `getMedia(channel, mediaId)` | `GET /{media-id}?fields=permalink,caption,media_type,thumbnail_url,media_url` |
| `replyToComment(channel, commentId, message)` | `POST /{comment-id}/replies` body `{ message }` |
| `deleteComment(channel, commentId)` | `DELETE /{comment-id}` |
| `setCommentHidden(channel, commentId, hide)` | `POST /{comment-id}` body `{ hide }` |
| `sendPrivateReply(channel, commentId, text)` | reutiliza `sendMessage` com `{ recipient: { comment_id }, message: { text } }` |

Erros passam por `wrapGraphError` como os demais.

### 3.4 Módulo `social-comments`

Pasta `src/modules/social-comments/` seguindo o padrão de `tags`:
`social-comments.module.ts`, `.controller.ts`, `.service.ts`, `.repository.ts`, `dto/`.

Guards: `JwtAuthGuard, OrgGuard, RolesGuard`. Toda rota recebe
`@CurrentChannelAccess()` e o service chama `ChannelAccessService.assertChannelAccess`
com o `channelId` do comentário (ou filtra a listagem pelos canais acessíveis).

| Rota | Roles | Ação |
|---|---|---|
| `GET /social-comments` | qualquer membro | Lista raízes paginadas por cursor (`commentedAt desc`), com `replies[]` aninhadas. Query: `channelId?`, `status?` (`VISIBLE`, `HIDDEN`, `DELETED`), `unreplied?=true`, `cursor?`, `limit?` (default 30, max 100). Respeita `ChannelAccess`. |
| `POST /social-comments/:id/reply` | qualquer membro | Body `{ text }`. Chama `replyToComment`, cria `SocialComment` filho com `isFromPage=true`, seta `repliedAt/repliedById` no pai, emite `comment:updated`. |
| `PATCH /social-comments/:id/hide` | qualquer membro | Body `{ hidden: boolean }`. Chama `setCommentHidden`, atualiza status `HIDDEN`/`VISIBLE`, emite `comment:updated`. |
| `DELETE /social-comments/:id` | OWNER, ADMIN | Chama `deleteComment`, status `DELETED` (soft, registro fica pra histórico), emite `comment:updated`. |
| `POST /social-comments/:id/private-reply` | qualquer membro | Body `{ text }`. Ver 3.5. Retorna `{ conversationId }`. |
| `POST /social-comments/:id/suggest` | qualquer membro | Ver 3.6. Retorna `{ text }`. |

Regras comuns:
- Comentário deve pertencer à org (`organizationId`) senão 404.
- Ações em comentário `DELETED` retornam 400.
- Se a Graph API falhar, nada muda no banco e o erro sobe como `BadGatewayException`
  com a mensagem da Meta (o front mostra no toast).

### 3.5 Private reply (abrir DM)

Meta permite exatamente uma private reply por comentário.

1. Carrega comentário + canal. Se `privateReplyConversationId` já existe, retorna 409
   com `{ message: 'DM já aberta para este comentário', conversationId }` para o
   front navegar.
2. `InstagramHttpClient.sendPrivateReply(channel, comment.externalId, text)`.
3. Resolve contato pelo IGSID do autor. `ContactResolverService.resolve()` exige
   `NormalizedInboundMessage`; adicionar `resolveByExternalId(organizationId,
   channelId, externalContactId, name?)` que reaproveita o bloco `createContact`
   já compartilhado entre `resolve()` e `resolveManual()`. `name = authorUsername`.
4. `ConversationResolverService.resolveForOperator(orgId, channelId, contactId, userId)`.
5. Persiste `Message` outbound (`direction OUTBOUND`, `type TEXT`, `status SENT`,
   `externalMessageId` retornado pela Meta, `senderId = userId`) via
   `MessagesRepository.create`, e emite o mesmo evento realtime que
   `MessagesService.send` emite após envio (extrair helper se necessário). Não passa
   pela fila `outbound-messages` porque o envio já aconteceu com `recipient.comment_id`.
6. Grava `privateReplyConversationId` no comentário. Retorna `{ conversationId }`.

O bloqueio "não é possível iniciar conversa no Instagram" em `startConversation`
continua valendo. Private reply é a exceção documentada pela Meta e vive só nesta rota.

### 3.6 Sugestão com IA

`POST /social-comments/:id/suggest` monta um prompt com `LlmService.complete`:

- `modelId`: `SAKANA_CONVERSATION_MODEL`.
- system: identidade da conta (`channel.name`), `organization.aiBusinessNotes` se existir,
  instruções: responder em PT-BR, tom cordial, curto (até 2 frases), sem inventar
  preços/prazos, sem links. Se o comentário for ofensivo ou spam, retornar
  `{ text: '', reason: 'spam' }`.
- user: legenda do post + comentário raiz + replies anteriores da thread.
- `maxTokens: 200`, `temperature: 0.5`.

Retorna `{ text, reason? }`. Nunca envia sozinho. Sem persistência do rascunho.

### 3.7 Realtime

Eventos emitidos com `emitToChannel(channelId, ...)`:

- `comment:new` payload: comentário raiz completo.
- `comment:updated` payload: comentário raiz completo com `replies[]`.

Reaproveita o join em `channel:<id>` que já existe, então permissão de canal por
membro é respeitada sem código extra.

### 3.8 Tratamento de erros

- Webhook com `changes` malformado: entra em `errors[]` do parse, resto do payload
  continua sendo processado (mesmo padrão atual).
- Enriquecimento de mídia falhando: loga `warn`, comentário salvo sem mídia. O front
  mostra placeholder.
- Token sem scope de comentários: Graph retorna erro de permissão. `wrapGraphError`
  já traduz; o service repassa. Tela mostra a mensagem da Meta.

## 4. Frontend (`chat-bullq-web`)

### 4.1 Rota e navegação

- `src/app/(dashboard)/comments/page.tsx`.
- Item `{ href: '/comments', label: 'Comentários', icon: MessageSquareText }` em
  `app-sidebar.tsx`, seguindo a ordem atual dos itens (após Inbox, antes de Projetos).

### 4.2 Feature `src/features/comments/`

```
services/comments.service.ts        // axios: list, reply, hide, remove, privateReply, suggest
hooks/use-comments.ts               // useInfiniteQuery com useOrgQueryKey, filtros na key
hooks/use-comments-socket.ts        // socket.on('comment:new' | 'comment:updated') -> invalidate
components/comments-filters.tsx     // canal (só INSTAGRAM), status: todos | sem resposta | ocultos | deletados
components/comment-list.tsx         // lista + "carregar mais" + empty state com aviso dos pré-requisitos
components/comment-card.tsx         // thumb do post (link permalink), @autor, texto, tempo relativo, badge status, thread de replies
components/comment-reply-box.tsx    // textarea + "Sugerir com IA" + "Responder"
components/private-reply-dialog.tsx // modal com textarea; sucesso navega para /inbox?conversationId=...
```

### 4.3 Comportamento

- Lista ordenada por `commentedAt desc`, 30 por página, botão "carregar mais".
- Ações com `useMutation`; sucesso invalida a query e mostra toast (`sonner`).
  Ocultar/desocultar faz update otimista do status; deletar pede confirmação.
- "Sugerir com IA" preenche a textarea (não envia). Botão fica desabilitado enquanto carrega.
  Se vier `reason: 'spam'`, mostra toast informando.
- Comentário `DELETED` aparece esmaecido, sem ações. `HIDDEN` mostra badge e ação "Desocultar".
- Comentário com `privateReplyConversationId` mostra link "Ver DM" em vez de "Abrir DM".
  Resposta 409 do private-reply também navega para a conversa informada.
- Deep-link `/inbox?conversationId=` já é suportado pela página do inbox.

## 5. Testes

Backend (Jest, já existente):

- `instagram.message-mapper.spec.ts`: `normalizeComment` com payload real de comentário,
  reply (`parent_id`) e payload sem `from`.
- `instagram.inbound-adapter.spec.ts`: `parseWebhook` mistura `messaging` + `changes`
  e retorna ambos; ignora `changes` de outro `entry.id`.
- `social-comments.service.spec.ts`: `ingest` idempotente (upsert 2x = 1 registro),
  reply da página marca `repliedAt` no pai, `reply/hide/delete` chamam http client e só
  persistem em sucesso, `privateReply` rejeita segunda tentativa com 409, `suggest`
  monta prompt com legenda + comentário.

Frontend: sem infra de teste no repo. Validação manual: replay de webhook via
`webhook_events` + checagem visual da lista, ações e realtime.

## 6. Sequência de entrega

1. Prisma model + migration + tipos do port + mapper + adapter + gateway + ingest
   (webhook chega e aparece no banco).
2. Http client + service/controller de ações (reply/hide/delete).
3. Private reply + suggest.
4. Front: rota, lista, filtros, realtime.
5. Front: ações, dialog de DM, sugestão IA.
