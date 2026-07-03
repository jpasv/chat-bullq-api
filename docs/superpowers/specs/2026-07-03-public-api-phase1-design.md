# Public API — Fase 1: Núcleo de Integração (Design)

**Data:** 2026-07-03
**Status:** Aprovado para implementação
**Escopo:** Fase 1 de um esforço maior de expor uma API pública "estilo Umbler Talk"
para o Chat BullQ (schema próprio, não drop-in da Umbler).

---

## 1. Contexto e objetivo

O Chat BullQ já é uma API omnichannel (NestJS + Prisma) com a fundação de API
pública pronta:

- Autenticação por API-key (`pk_...`, hash SHA-256, model `ApiKey`, `ApiKeyAuthGuard`,
  estratégia Passport `api-key`).
- Módulo `PublicApiModule` com `/public/me` e `/public/dashboard/*`.
- Domínio completo já modelado: `Contact`, `ContactChannel`, `Conversation`,
  `Message`, `Channel`, `Tag`, `WebhookEvent`, `OutboxEvent`, membros via
  `UserOrganization`.
- Serviços internos testados: `ContactsService`, `ConversationsService`,
  `MessagesService`, `ChannelsService`, `ContactResolverService`.
- Convenções transversais: `ResponseInterceptor` (envelope `{ data, meta }`),
  `GlobalExceptionFilter`, `PaginationDto` (`page`/`limit`).

**Objetivo da Fase 1:** expor a superfície de integração que fecha o caso
"um sistema externo lê contatos/conversas e envia/recebe mensagens", **reusando
os serviços internos existentes** — sem reimplementar lógica de negócio.

Decomposição completa do esforço (cada fase = spec → plano → implementação
próprios):

- **Fase 1 (este doc):** Contacts, Channels, Conversations, Messages.
- **Fase 2:** Webhooks / Subscriptions de eventos (padrão `OutboxEvent`/`WebhookEvent`).
- **Fase 3:** Members, Organizations, Tags, Quick Replies, Departments, Activity Logs.
- **Fase 4:** AI Agents (expor publicamente o módulo `ai-agents`).

---

## 2. Princípios de arquitetura

**Aditivo apenas — não mexer no que já existe.** Nenhum endpoint, serviço,
DTO ou comportamento atual é modificado. A Fase 1 só **adiciona** controllers,
DTOs, mappers e guards novos no `PublicApiModule`, e uma página nova no front.
Os serviços internos reusados (`ContactsService`, etc.) são consumidos como
estão; se algum precisar de um método novo, ele é **adicionado** sem alterar
os existentes.

**Controllers finos + camada de contrato público (mappers).**

- Controllers `public/*` chamam os serviços internos existentes; nenhuma regra
  de negócio nova vive na camada pública.
- Uma camada fina de **DTOs públicos + mappers por recurso** define o contrato
  público **estável**, desacoplado do shape interno do Prisma. Mudança interna
  não quebra clientes.
- Reuso máximo: `MessagingModule` já exporta `ContactsService`,
  `ConversationsService`, `MessagesService`; `ChannelsService` vive em
  `ChannelHubModule`.

**Autenticação e escopo (server-to-server).**

- Todo endpoint: `@UseGuards(ApiKeyAuthGuard)` + `@ApiSecurity('api-key')`.
- Org sempre de `@CurrentOrg('id')`; nunca aceita `organizationId` do body/query.
- Sender de envio = `@CurrentUser('id')` (o usuário dono da API-key).
- A API-key é da organização inteira → opera com `access: ChannelAccess = 'ALL'`
  (enxerga todos os canais da org). Não há visibilidade escopada por usuário na
  API pública — é coerente com integração server-to-server.

---

## 3. Estrutura de arquivos

```
src/modules/public-api/
  public-api.module.ts            # + imports MessagingModule, ChannelHubModule; + novos controllers/guards
  controllers/
    public-me.controller.ts       # (existe)
    public-dashboard.controller.ts# (existe)
    public-contacts.controller.ts # novo
    public-channels.controller.ts # novo
    public-conversations.controller.ts # novo
    public-messages.controller.ts # novo
  dto/
    public-pagination.dto.ts       # page/limit + shape de resposta paginada público
    create-contact.public.dto.ts
    update-contact.public.dto.ts
    list-conversations.public.dto.ts
    send-message.public.dto.ts
  mappers/
    contact.mapper.ts
    channel.mapper.ts
    conversation.mapper.ts
    message.mapper.ts
  guards/
    api-key-throttle.guard.ts      # rate limit por API-key (padrão do webhook-throttle.guard)
```

---

## 4. Endpoints

Todos sob o prefixo global `api/v1` → paths finais `api/v1/public/...`.

### 4.1 Contacts

| Método + rota | Serviço reusado | Notas |
|---|---|---|
| `GET /public/contacts` | `ContactsService.findAll(orgId, search, page, limit)` | lista paginada; query: `search`, `page`, `limit` |
| `GET /public/contacts/:id` | `ContactsService.findOne(id, orgId)` | 404 se fora da org |
| `POST /public/contacts` | `ContactResolverService.resolve(...)` | cria/resolve por telefone+canal; ver §5 |
| `PATCH /public/contacts/:id` | `ContactsService.update(id, orgId, dto)` | `CreateContactPublicDto`/`UpdateContactPublicDto` |
| `DELETE /public/contacts/:id` | `ContactsService.remove(id, orgId)` | |

### 4.2 Channels

| Método + rota | Serviço reusado |
|---|---|
| `GET /public/channels` | `ChannelsService.findAll(orgId, 'ALL')` |
| `GET /public/channels/:id` | `ChannelsService.findOne(id, orgId, 'ALL')` |

Somente leitura na Fase 1 (criar/editar canal envolve provisionamento de provider
— fora do escopo de integração).

### 4.3 Conversations (chats)

| Método + rota | Serviço reusado | Notas |
|---|---|---|
| `GET /public/conversations` | `ConversationsService.findInbox(orgId, filters, page, limit, 'ALL')` | filtros: `status`, `channelId`, `tagIds`, `search`, `archived` |
| `GET /public/conversations/:id` | `ConversationsService.findOne(id, orgId, 'ALL')` | |
| `GET /public/conversations/:id/messages` | `MessagesService.findByConversation(id, orgId, ...)` | paginado |
| `POST /public/conversations/:id/close` | `ConversationsService.close(...)` | |
| `POST /public/conversations/:id/reopen` | `ConversationsService.reopen(...)` | |
| `POST /public/conversations/:id/assign` | `ConversationsService.update(id, orgId, { assignedToId, departmentId })` | transferir p/ agente ou setor |

### 4.4 Messages

| Método + rota | Serviço reusado | Notas |
|---|---|---|
| `POST /public/messages` | `MessagesService.send(dto, senderId, orgId, 'ALL')` | envia texto/mídia; suporta `replyTo` |

`SendMessagePublicDto` espelha o `SendMessageDto` interno: `conversationId`,
`type` (`TEXT`/`IMAGE`/`AUDIO`/`VIDEO`/`DOCUMENT`), `content`, `replyToMessageId?`.
Recebimento de mensagens (inbound) é via webhooks — Fase 2.

---

## 5. Criação de contato (POST /public/contacts)

Contatos internamente nascem de mensagens recebidas via `ContactResolverService`.
Para a API pública, expomos criação reusando esse resolver:

- Body: `{ phone (E.164), name?, channelId }`.
- O controller resolve o `Channel` da org, chama `ContactResolverService.resolve(...)`
  com os dados de perfil, e retorna o contato mapeado.
- Idempotente por (channel, phone): se já existe, retorna o existente (comportamento
  natural do resolver). Documentar isso no Swagger.
- **A confirmar no plano de implementação:** assinatura exata de `resolve(...)` e
  quais campos de perfil ele aceita (o design assume telefone + canal + nome).

---

## 6. Contrato público: DTOs, mappers e paginação

- **Mappers por recurso** convertem entidade Prisma → shape público, escondendo
  FKs cruas e flags internas. Ex.: `contact.mapper.ts` expõe
  `{ id, name, phone, channels, tags, createdAt, updatedAt }` e omite campos
  internos.
- **Paginação pública padronizada.** Toda lista retorna:

  ```json
  { "items": [ ... ], "page": 1, "limit": 20, "total": 137, "hasMore": true }
  ```

  Envelopado pelo `ResponseInterceptor` existente em `{ data, meta: { timestamp } }`.
  Um helper `toPublicPage(items, total, page, limit)` centraliza o cálculo de
  `hasMore`.
- **Erros.** Reusa `GlobalExceptionFilter`. Shape público consistente:
  `{ statusCode, message, error }`. 401 sem key válida, 403 fora da org, 404
  recurso inexistente, 422/400 validação, 429 rate limit.

---

## 7. Rate limiting

Guard `ApiKeyThrottleGuard` — sliding window in-memory, espelhando o
`WebhookThrottleGuard` existente, mas **keyed por API-key** (prefixo/id da key)
em vez de IP.

- Limite inicial generoso e configurável por env (ex.: ~100 req / 5s por key,
  alinhado à ordem de grandeza documentada pela Umbler).
- Excedente → `429 Too Many Requests`.
- Aplicado globalmente nos controllers `public/*` (via `@UseGuards` no controller
  ou provider por módulo).
- In-memory é aceitável na Fase 1 (single-instance / sticky). Nota de evolução:
  migrar para Redis (`ioredis` já é dependência) quando rodar multi-instância —
  fica registrado como débito, não bloqueia a Fase 1.

---

## 8. Documentação (Swagger / OpenAPI)

Segundo documento Swagger dedicado, só com os controllers públicos:

- `SwaggerModule.setup('docs/public', app, publicDocument)` em `main.ts`, usando
  `DocumentBuilder` com `.addApiKey(...)` e filtrando pelos controllers do
  `PublicApiModule` (via `include: [PublicApiModule]`).
- Mantém `/docs` (interno) intacto.
- Gera um `openapi.json` publicável — o análogo do doc da Umbler para os clientes
  da integração.

---

## 9. Front — Página no Admin ("Desenvolvedores / API")

Reusar e ampliar a página existente `src/app/(dashboard)/settings/api-keys/`
(hoje enquadrada em MCP) para uma página **Desenvolvedores / API pública** —
sem quebrar a gestão de chaves atual.

**App:** `chat-bullq-web` (Next 16, React 19, TanStack Query, Tailwind, axios,
padrão `features/`).

Conteúdo da página (duas seções na mesma rota):

1. **Chaves de API** (já existe — mantida): criar/listar/revogar via
   `apiKeysService`. Ajuste no texto do modal para apontar tanto MCP quanto a
   nova API pública REST.
2. **Referência da API pública** (nova seção):
   - Base URL (`.../api/v1/public`) e header de auth (`Authorization: Bearer pk_...`).
   - Lista dos endpoints da Fase 1 (Contacts, Channels, Conversations, Messages)
     com método, path e um exemplo `curl` copiável por recurso.
   - Botão/link "Abrir documentação interativa" → Swagger dedicado em `/docs/public`.

Implementação: componentes em `src/features/settings/components/` (ex.:
`api-reference.tsx`), consumindo uma constante estática de endpoints (o front não
precisa gerar OpenAPI — o Swagger `/docs/public` é a fonte interativa). Sem novos
services de dados além do `apiKeysService` já existente.

Fora de escopo do front na Fase 1: playground de requisições, gestão de webhooks
(Fase 2), métricas de uso por chave.

## 10. Testes

- **e2e por recurso** (padrão Jest já existente no projeto):
  - Sem key válida → 401.
  - Key de outra org não enxerga recursos → 404/403.
  - Paginação: `page`/`limit`, `total`, `hasMore` corretos.
  - `POST /public/messages` → mensagem persistida + saída enfileirada (mock do
    adapter de canal).
  - `POST /public/contacts` → cria e é idempotente por (channel, phone).
  - `429` ao estourar o rate limit.
- **Unit** para mappers (entidade → shape público, sem vazar campos internos).

---

## 11. Fora de escopo da Fase 1

- Webhooks / subscriptions de eventos (Fase 2).
- Members, Organizations, Tags, Quick Replies, Departments, Activity Logs (Fase 3).
- AI Agents (Fase 4).
- Criação/edição de canais (envolve provisionamento de provider).
- Rate limit distribuído em Redis (débito registrado em §7).

---

## 12. Riscos / pontos a resolver no plano

1. Assinatura exata de `ContactResolverService.resolve(...)` e campos de perfil
   aceitos (§5).
2. Shape de retorno atual de `ContactsService.findAll` / `findInbox` — confirmar
   para o mapper cobrir todos os campos públicos desejados.
3. `MessagesService.findByConversation` — confirmar parâmetros de paginação.
4. Método de "assign/transfer": confirmar que `ConversationsService.update` cobre
   `assignedToId` + `departmentId` com as validações necessárias (o
   `UpdateConversationDto` já expõe ambos).
