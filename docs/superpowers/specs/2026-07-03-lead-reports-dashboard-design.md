# Relatórios de Leads no Dashboard — Design

**Data:** 2026-07-03
**Repos:** `chat-bullq-api` (branch `feat/lead-reports-dashboard`, a partir de `feat/lead-distribution`), `chat-bullq-web`
**Status:** aprovado no brainstorming; pendente escrita do plano de implementação

## Contexto

O dashboard atual (`modules/dashboard` na API, `features/dashboard` no web) é centrado em conversas e já aplica a barreira RN-05 (AGENT vê só as próprias conversas; OWNER/ADMIN veem a org). Hoje **a página web não tem barra de filtros** — toda query chama o serviço sem `from`/`to`, e o backend assume "últimos 30 dias".

O usuário (OFP) quer relatórios focados em **leads e distribuição por vendedor**, com o máximo de filtros.

### Definições travadas (brainstorming)

- **Lead** = conversa que entrou na fila de distribuição. Como a automação **RN-01 tem `conditions: {}` e marca TODA conversa nova com a tag `Distribuir`**, operacionalmente **novo lead ≡ conversa criada no período** (`Conversation.createdAt`). Isso é confiável e não depende da tabela `ConversationTag` (join puro, sem timestamp; a tag `Distribuir` é removida na atribuição pela RN-04, então não há histórico recuperável por tag).
- **"Clientes que responderam a 1ª msg"** = lead **proativo** (1ª mensagem da conversa é `OUTBOUND`) em que o cliente respondeu depois (existe pelo menos 1 `INBOUND` posterior). É taxa de engajamento de leads que nós abordamos (ex.: Zappfy).
- **Vendedor** = `Conversation.assignedToId` **atual** (usuários com papel AGENT / rótulo "Operador"). Sem reconstrução de 1ª atribuição via audit log.

## Métricas (itens do usuário)

1. **Nº de novos leads** — conversas criadas no período (com filtros).
2. **Nº de clientes que responderam a 1ª msg** — count + taxa, sobre leads proativos.
3. **Leads por vendedor** e 4. **Leads novos enviados para cada vendedor** — unificados numa **tabela por vendedor** (decisão aprovada), pois com "assignedTo atual" ambos compartilham a base.

## Arquitetura

### Backend — `dashboard.service.ts`

Novo tipo de filtro reaproveitável:

```ts
export interface LeadsFilter {
  from: Date;
  to: Date;
  channelId?: string;
  departmentId?: string;
  assignedToId?: string; // filtro explícito de vendedor (OWNER/ADMIN)
  status?: ConversationStatus;
}
```

Helper privado `leadsWhere(orgId, filter, scope)` que monta o `where` de `Conversation` combinando:
- `organizationId`, `createdAt` no range;
- filtros opcionais (`channelId`, `departmentId`, `status`);
- **barreira RN-05**: o `scope` (`{ assignedToId }` para AGENT, `{}` para OWNER/ADMIN) tem precedência — se `scope.assignedToId` está setado, o filtro `assignedToId` do query param é ignorado (fail-closed, um AGENT não escapa do próprio escopo).

Novo método:

```ts
getLeadsReport(orgId, filter, scope): Promise<LeadsReport>
```

Retorno:

```ts
interface LeadsReport {
  newLeads: number;              // conversas criadas no período
  proactiveLeads: number;        // leads cuja 1ª msg é OUTBOUND
  respondedLeads: number;        // proativos com >=1 INBOUND posterior
  respondedRate: number | null;  // respondedLeads / proactiveLeads (%)
  bySeller: Array<{
    seller: { id: string; name: string; avatarUrl: string | null } | null; // null = "Na fila / não distribuídos"
    received: number;            // novos leads no período atribuídos a ele
    responded: number;           // desses, quantos o cliente respondeu (proativos)
    open: number;                // status OPEN/PENDING/WAITING
    closed: number;              // status CLOSED
    avgFirstResponseMin: number | null;
  }>;
}
```

**Cálculo de proativo/respondido:** carregar as conversas do período (`id, assignedToId, status, createdAt, firstResponseAt`) e suas mensagens (`conversationId, direction, createdAt`) para determinar, por conversa: direção da 1ª msg e existência de INBOUND. Agregar em memória (escala OFP é pequena; índice `idx_conv_contact`/`conversation_id` cobre o join de mensagens). A linha "Na fila / não distribuídos" agrega conversas com `assignedToId = null`.

### Backend — `dashboard.controller.ts`

- Novo endpoint `GET /dashboard/leads` com `@ApiQuery` para `from, to, channelId, departmentId, assignedToId, status`.
- Parsing dos filtros num helper `parseLeadsFilter(query)` reusando `parseRange`.
- Escopo de vendedor: `assignmentScope(userId, role)` como nos demais endpoints; o `assignedToId` do query param só é honrado quando o `scope` é vazio (OWNER/ADMIN).
- **Estender os endpoints existentes** (overview, volume-by-day, volume-by-channel, agent-performance, volume-flow, messages-flow, peak-hours, bot-performance, top-tags, csat, reopens, kpi-sparklines) para aceitar os mesmos filtros opcionais (`channelId`, `departmentId`, `status`, `assignedToId`), de modo que a barra de filtros do front valha para o dashboard inteiro. Cada método do service passa a receber o `LeadsFilter` (ou um subconjunto) e aplicá-lo no `where`.

### Frontend — `chat-bullq-web`

1. **Barra de filtros (nova)** no topo de `app/(dashboard)/dashboard/page.tsx`:
   - **Período**: presets (7d / 30d / 90d / custom com date range).
   - **Vendedor**: dropdown de usuários AGENT (visível só para OWNER/ADMIN).
   - **Canal**: dropdown de canais da org.
   - **Departamento**: dropdown.
   - **Status**: dropdown (OPEN/PENDING/WAITING/CLOSED/BOT).
   - Estado via `useState` (um objeto `filters`), injetado em **todas** as `queryKey` e `queryFn`. Fonte de dados dos dropdowns: serviços existentes de canais/usuários/departamentos.
2. **`dashboard.service.ts`**: cada método passa a aceitar o objeto de filtros e serializar em query params; novo `getLeadsReport(filters)` + interface `LeadsReport`.
3. **Seção "Leads / Distribuição"** (nova) na página:
   - 3 cards: **Novos leads**, **Clientes que responderam** (valor + % `respondedRate`), e **Leads na fila** (não distribuídos).
   - **Tabela por vendedor** (`bySeller`): colunas Vendedor · Recebidos · Respondidos · Em aberto · Fechados · TMR 1ª resposta; linha final "Na fila / não distribuídos".

## Data flow

Filtros (front `useState`) → query params → controller `parseLeadsFilter` → `LeadsFilter` + `scope` (RN-05) → `where` de Prisma → agregação → JSON → React Query → cards/tabela.

## Erros e bordas

- **RN-05 fail-closed**: AGENT nunca vê leads de terceiros; `scope.assignedToId` sobrepõe o filtro de vendedor do query param.
- **OFP majoritariamente receptivo**: se poucos leads forem proativos, `respondedLeads`/`respondedRate` virão baixos. Mitigação: o card mostra o denominador (`proactiveLeads`) para dar contexto; split proativo vs receptivo fica como extensão opcional (não no escopo v1, a confirmar).
- **Sem leads no período**: cards em 0, `respondedRate = null` (exibir "—"), tabela vazia.
- **Vendedor sem nome/avatar**: já tratado (relação opcional).

## Testes

- Unit (Jest) em `dashboard.service`: `getLeadsReport` — novos leads no range; proativo detectado pela 1ª msg OUTBOUND; respondido só quando há INBOUND posterior; `bySeller` agrupa por `assignedToId` e a linha `null` agrega não-distribuídos; filtros (channel/department/status) aplicados; **RN-05**: com `scope.assignedToId` setado, filtro de vendedor divergente é ignorado.
- Controller: `parseLeadsFilter` mapeia query params; escopo honra papel.

## Fora de escopo (v1)

- Reconstrução de 1ª atribuição via audit log (usuário escolheu "assignedTo atual").
- Split proativo vs receptivo (extensão opcional).
- Export CSV dos relatórios.
