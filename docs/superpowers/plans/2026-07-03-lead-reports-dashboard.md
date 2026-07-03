# Relatórios de Leads no Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao dashboard relatórios de leads (novos leads, clientes que responderam a 1ª msg, leads por vendedor) com barra de filtros (período, vendedor, canal, departamento, status).

**Architecture:** Backend NestJS+Prisma: novo método `getLeadsReport` no `DashboardService` + endpoint `GET /dashboard/leads`, ambos respeitando a barreira RN-05. Filtros compartilhados (`channelId/departmentId/status/assignedToId`) estendidos aos endpoints existentes. Frontend Next.js: barra de filtros com estado em `useState` injetado em todas as queries + seção "Leads / Distribuição" (cards + tabela por vendedor).

**Tech Stack:** NestJS, Prisma, Jest (backend); Next.js, React Query, Recharts, Tailwind (frontend).

---

## Contexto essencial para quem implementa

- **Lead = conversa criada no período.** A automação RN-01 (`conditions: {}`) marca toda conversa nova com a tag `Distribuir`, então "entrou na fila de distribuição" ≡ `Conversation.createdAt` no range. Não usar a tabela `ConversationTag` (join sem timestamp; a tag é removida na atribuição).
- **Vendedor = `Conversation.assignedToId`** (usuários papel AGENT). RN-05: AGENT só vê as próprias conversas. O helper `resolveAssignmentScope(role, userId)` (em `src/modules/messaging/conversations/conversation-scope.ts`) retorna `undefined` para OWNER/ADMIN e o `userId` para AGENT.
- **Lead proativo** = 1ª mensagem da conversa é `OUTBOUND`. **Respondido** = existe pelo menos 1 `INBOUND` posterior.
- Enums: `ConversationStatus = PENDING|BOT|OPEN|WAITING|CLOSED`; `MessageDirection = INBOUND|OUTBOUND`.
- Arquivos backend: `src/modules/dashboard/dashboard.service.ts`, `dashboard.controller.ts`. Não há spec de dashboard ainda — criar `dashboard.service.spec.ts`.
- Padrão de teste (Jest): instanciar o service com prisma mockado — `new DashboardService(prismaMock as any)`; mockar só os métodos usados.

## File Structure

**Backend (`chat-bullq-api`):**
- Modify: `src/modules/dashboard/dashboard.service.ts` — novo `LeadsFilter`, `ConvFilters`, helper `applyConvFilters`, método `getLeadsReport`; filtros nos métodos existentes.
- Modify: `src/modules/dashboard/dashboard.controller.ts` — endpoint `GET /dashboard/leads`, helper `parseLeadsFilter`, filtros nos endpoints existentes.
- Create: `src/modules/dashboard/dashboard.service.spec.ts` — testes de `getLeadsReport` + `applyConvFilters`.

**Frontend (`chat-bullq-web`):**
- Modify: `src/features/dashboard/services/dashboard.service.ts` — interface `LeadsReport`, `getLeadsReport`, tipo `DashboardFilters`, serialização em todos os métodos.
- Create: `src/features/dashboard/components/DashboardFilters.tsx` — barra de filtros.
- Create: `src/features/dashboard/components/LeadsSection.tsx` — cards + tabela por vendedor.
- Modify: `src/app/(dashboard)/dashboard/page.tsx` — estado de filtros, renderiza barra + seção, injeta filtros nas queries.

---

## Task 1: `applyConvFilters` + tipos de filtro (backend)

**Files:**
- Modify: `src/modules/dashboard/dashboard.service.ts`
- Test: `src/modules/dashboard/dashboard.service.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

Criar `src/modules/dashboard/dashboard.service.spec.ts`:

```ts
import { DashboardService } from './dashboard.service';

describe('DashboardService.applyConvFilters', () => {
  const service = new DashboardService({} as any);
  // acesso ao método privado via cast
  const apply = (base: any, filters: any, scope?: string) =>
    (service as any).applyConvFilters(base, filters, scope);

  it('mescla channelId/departmentId/status no where', () => {
    const where = apply({ organizationId: 'org-1' }, {
      channelId: 'ch-1', departmentId: 'dep-1', status: 'OPEN',
    });
    expect(where).toEqual({
      organizationId: 'org-1', channelId: 'ch-1', departmentId: 'dep-1', status: 'OPEN',
    });
  });

  it('honra assignedToId do filtro quando não há scope', () => {
    const where = apply({ organizationId: 'org-1' }, { assignedToId: 'u-1' });
    expect(where.assignedToId).toBe('u-1');
  });

  it('RN-05: scope sobrepõe o assignedToId do filtro (fail-closed)', () => {
    const where = apply({ organizationId: 'org-1' }, { assignedToId: 'u-OUTRO' }, 'u-AGENT');
    expect(where.assignedToId).toBe('u-AGENT');
  });

  it('ignora campos undefined', () => {
    const where = apply({ organizationId: 'org-1' }, {});
    expect(where).toEqual({ organizationId: 'org-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chat-bullq-api && yarn jest dashboard.service.spec -t applyConvFilters`
Expected: FAIL — `applyConvFilters is not a function`.

- [ ] **Step 3: Implement `LeadsFilter`, `ConvFilters` e `applyConvFilters`**

No topo de `dashboard.service.ts`, após o `import`, adicionar os tipos:

```ts
import { ConversationStatus, Prisma } from '@prisma/client';

export interface ConvFilters {
  channelId?: string;
  departmentId?: string;
  status?: ConversationStatus;
  assignedToId?: string;
}

export interface LeadsFilter extends ConvFilters {
  from: Date;
  to: Date;
}
```

Dentro da classe `DashboardService`, adicionar o helper privado:

```ts
/**
 * Mescla filtros opcionais num `where` de Conversation, respeitando RN-05:
 * quando `scope` (userId do AGENT) está setado, ele sobrepõe qualquer
 * `assignedToId` vindo do filtro (fail-closed — o AGENT não escapa do escopo).
 */
private applyConvFilters<T extends Record<string, unknown>>(
  base: T,
  filters: ConvFilters,
  scope?: string,
): T & Record<string, unknown> {
  const where: Record<string, unknown> = { ...base };
  if (filters.channelId) where.channelId = filters.channelId;
  if (filters.departmentId) where.departmentId = filters.departmentId;
  if (filters.status) where.status = filters.status;
  const assigned = scope ?? filters.assignedToId;
  if (assigned) where.assignedToId = assigned;
  return where as T & Record<string, unknown>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn jest dashboard.service.spec -t applyConvFilters`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/modules/dashboard/dashboard.service.ts src/modules/dashboard/dashboard.service.spec.ts
git commit -m "feat(dashboard): applyConvFilters helper + tipos de filtro"
```

---

## Task 2: `getLeadsReport` (backend — núcleo)

**Files:**
- Modify: `src/modules/dashboard/dashboard.service.ts`
- Test: `src/modules/dashboard/dashboard.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Adicionar ao `dashboard.service.spec.ts`:

```ts
describe('DashboardService.getLeadsReport', () => {
  const range = { from: new Date('2026-07-01'), to: new Date('2026-07-31') };

  // Fábrica de prisma mock. `convs` são as conversas do período; `msgs` as mensagens.
  const buildPrisma = (convs: any[], msgs: any[]) => ({
    conversation: {
      findMany: jest.fn().mockResolvedValue(convs),
    },
    message: {
      findMany: jest.fn().mockResolvedValue(msgs),
    },
  });

  it('conta novos leads = conversas criadas no período', async () => {
    const prisma = buildPrisma(
      [
        { id: 'c1', assignedToId: 'v1', status: 'OPEN', createdAt: new Date('2026-07-02'), firstResponseAt: null, assignedTo: { id: 'v1', name: 'Vend 1', avatarUrl: null } },
        { id: 'c2', assignedToId: null, status: 'PENDING', createdAt: new Date('2026-07-03'), firstResponseAt: null, assignedTo: null },
      ],
      [],
    );
    const service = new DashboardService(prisma as any);
    const r = await service.getLeadsReport('org-1', { ...range });
    expect(r.newLeads).toBe(2);
  });

  it('proativo = 1ª msg OUTBOUND; respondido = tem INBOUND depois', async () => {
    const prisma = buildPrisma(
      [
        // c1: proativo respondido (out -> in)
        { id: 'c1', assignedToId: 'v1', status: 'OPEN', createdAt: new Date('2026-07-02'), firstResponseAt: new Date('2026-07-02T01:00:00Z'), assignedTo: { id: 'v1', name: 'Vend 1', avatarUrl: null } },
        // c2: proativo sem resposta (só out)
        { id: 'c2', assignedToId: 'v1', status: 'OPEN', createdAt: new Date('2026-07-02'), firstResponseAt: null, assignedTo: { id: 'v1', name: 'Vend 1', avatarUrl: null } },
        // c3: receptivo (1ª msg in) — não conta como proativo
        { id: 'c3', assignedToId: 'v1', status: 'OPEN', createdAt: new Date('2026-07-02'), firstResponseAt: null, assignedTo: { id: 'v1', name: 'Vend 1', avatarUrl: null } },
      ],
      [
        { conversationId: 'c1', direction: 'OUTBOUND', createdAt: new Date('2026-07-02T00:00:00Z') },
        { conversationId: 'c1', direction: 'INBOUND', createdAt: new Date('2026-07-02T00:30:00Z') },
        { conversationId: 'c2', direction: 'OUTBOUND', createdAt: new Date('2026-07-02T00:00:00Z') },
        { conversationId: 'c3', direction: 'INBOUND', createdAt: new Date('2026-07-02T00:00:00Z') },
      ],
    );
    const service = new DashboardService(prisma as any);
    const r = await service.getLeadsReport('org-1', { ...range });
    expect(r.proactiveLeads).toBe(2);   // c1, c2
    expect(r.respondedLeads).toBe(1);   // c1
    expect(r.respondedRate).toBe(50);
  });

  it('bySeller agrupa por assignedToId; não-atribuídos na linha null', async () => {
    const prisma = buildPrisma(
      [
        { id: 'c1', assignedToId: 'v1', status: 'OPEN', createdAt: new Date('2026-07-02'), firstResponseAt: null, assignedTo: { id: 'v1', name: 'Vend 1', avatarUrl: null } },
        { id: 'c2', assignedToId: 'v1', status: 'CLOSED', createdAt: new Date('2026-07-02'), firstResponseAt: null, assignedTo: { id: 'v1', name: 'Vend 1', avatarUrl: null } },
        { id: 'c3', assignedToId: null, status: 'PENDING', createdAt: new Date('2026-07-02'), firstResponseAt: null, assignedTo: null },
      ],
      [],
    );
    const service = new DashboardService(prisma as any);
    const r = await service.getLeadsReport('org-1', { ...range });
    const v1 = r.bySeller.find((s) => s.seller?.id === 'v1')!;
    expect(v1.received).toBe(2);
    expect(v1.open).toBe(1);
    expect(v1.closed).toBe(1);
    const fila = r.bySeller.find((s) => s.seller === null)!;
    expect(fila.received).toBe(1);
  });

  it('respondedRate = null quando não há leads proativos', async () => {
    const prisma = buildPrisma([], []);
    const service = new DashboardService(prisma as any);
    const r = await service.getLeadsReport('org-1', { ...range });
    expect(r.newLeads).toBe(0);
    expect(r.respondedRate).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn jest dashboard.service.spec -t getLeadsReport`
Expected: FAIL — `getLeadsReport is not a function`.

- [ ] **Step 3: Implement `getLeadsReport`**

Adicionar à classe `DashboardService`:

```ts
async getLeadsReport(
  organizationId: string,
  filter: LeadsFilter,
  scope?: string,
) {
  const where = this.applyConvFilters(
    { organizationId, createdAt: { gte: filter.from, lte: filter.to } },
    filter,
    scope,
  );

  const conversations = await this.prisma.conversation.findMany({
    where: where as Prisma.ConversationWhereInput,
    select: {
      id: true,
      assignedToId: true,
      status: true,
      createdAt: true,
      firstResponseAt: true,
      assignedTo: { select: { id: true, name: true, avatarUrl: true } },
    },
  });

  const convIds = conversations.map((c) => c.id);
  const messages = convIds.length
    ? await this.prisma.message.findMany({
        where: { conversationId: { in: convIds } },
        select: { conversationId: true, direction: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  // Por conversa: direção da 1ª msg (mensagens já vêm ordenadas por createdAt) e se há INBOUND.
  const firstDir = new Map<string, 'INBOUND' | 'OUTBOUND'>();
  const hasInbound = new Set<string>();
  for (const m of messages) {
    if (!firstDir.has(m.conversationId)) firstDir.set(m.conversationId, m.direction);
    if (m.direction === 'INBOUND') hasInbound.add(m.conversationId);
  }

  let proactiveLeads = 0;
  let respondedLeads = 0;

  type Row = {
    seller: { id: string; name: string; avatarUrl: string | null } | null;
    received: number; responded: number; open: number; closed: number;
    frSum: number; frCount: number;
  };
  const rows = new Map<string, Row>(); // key = sellerId ou '__none__'

  for (const c of conversations) {
    const isProactive = firstDir.get(c.id) === 'OUTBOUND';
    const responded = isProactive && hasInbound.has(c.id);
    if (isProactive) proactiveLeads++;
    if (responded) respondedLeads++;

    const key = c.assignedToId ?? '__none__';
    if (!rows.has(key)) {
      rows.set(key, {
        seller: c.assignedTo ?? null,
        received: 0, responded: 0, open: 0, closed: 0, frSum: 0, frCount: 0,
      });
    }
    const row = rows.get(key)!;
    row.received++;
    if (responded) row.responded++;
    if (c.status === 'CLOSED') row.closed++;
    else if (c.status === 'OPEN' || c.status === 'PENDING' || c.status === 'WAITING') row.open++;
    if (c.firstResponseAt) {
      row.frSum += (c.firstResponseAt.getTime() - c.createdAt.getTime()) / 60000;
      row.frCount++;
    }
  }

  const bySeller = Array.from(rows.values())
    .map((r) => ({
      seller: r.seller,
      received: r.received,
      responded: r.responded,
      open: r.open,
      closed: r.closed,
      avgFirstResponseMin: r.frCount ? Math.round(r.frSum / r.frCount) : null,
    }))
    .sort((a, b) => b.received - a.received);

  return {
    newLeads: conversations.length,
    proactiveLeads,
    respondedLeads,
    respondedRate: proactiveLeads > 0 ? Math.round((respondedLeads / proactiveLeads) * 100) : null,
    bySeller,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn jest dashboard.service.spec`
Expected: PASS (todos os testes de Task 1 e 2).

- [ ] **Step 5: Commit**

```bash
git add src/modules/dashboard/dashboard.service.ts src/modules/dashboard/dashboard.service.spec.ts
git commit -m "feat(dashboard): getLeadsReport (novos leads, respondidos, por vendedor)"
```

---

## Task 3: Endpoint `GET /dashboard/leads` (backend)

**Files:**
- Modify: `src/modules/dashboard/dashboard.controller.ts`

- [ ] **Step 1: Implementar helper `parseLeadsFilter` e o endpoint**

No `dashboard.controller.ts`, adicionar o import do enum e, dentro da classe, o helper + endpoint:

```ts
import { ConversationStatus, OrgRole } from '@prisma/client';
import { LeadsFilter } from './dashboard.service';
```

Helper privado:

```ts
private parseLeadsFilter(
  from: string | undefined,
  to: string | undefined,
  channelId?: string,
  departmentId?: string,
  status?: string,
  assignedToId?: string,
): LeadsFilter {
  const range = this.parseRange(from, to);
  return {
    ...range,
    channelId: channelId || undefined,
    departmentId: departmentId || undefined,
    status: status ? (status as ConversationStatus) : undefined,
    assignedToId: assignedToId || undefined,
  };
}
```

Endpoint:

```ts
@Get('leads')
@ApiOperation({ summary: 'Relatório de leads (novos, respondidos, por vendedor)' })
@ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
@ApiQuery({ name: 'channelId', required: false }) @ApiQuery({ name: 'departmentId', required: false })
@ApiQuery({ name: 'status', required: false }) @ApiQuery({ name: 'assignedToId', required: false })
getLeads(
  @CurrentOrg('id') orgId: string,
  @CurrentUser('id') userId: string,
  @CurrentUserRole() role: OrgRole,
  @Query('from') from?: string,
  @Query('to') to?: string,
  @Query('channelId') channelId?: string,
  @Query('departmentId') departmentId?: string,
  @Query('status') status?: string,
  @Query('assignedToId') assignedToId?: string,
) {
  return this.service.getLeadsReport(
    orgId,
    this.parseLeadsFilter(from, to, channelId, departmentId, status, assignedToId),
    this.assignmentScope(userId, role),
  );
}
```

- [ ] **Step 2: Verificar build**

Run: `yarn build`
Expected: build verde (sem erros de tipo). Nota: usar `yarn build` (não só `tsc`) — o projeto compila via `nest build` com `tsconfig.build.json`.

- [ ] **Step 3: Smoke test manual (opcional se houver ambiente)**

Run: `curl -s "http://localhost:3000/api/v1/dashboard/leads?from=2026-06-01&to=2026-07-03" -H "Authorization: Bearer <token>" | jq`
Expected: JSON com `newLeads`, `respondedRate`, `bySeller`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/dashboard/dashboard.controller.ts
git commit -m "feat(dashboard): endpoint GET /dashboard/leads"
```

---

## Task 4: Estender filtros aos endpoints existentes (backend)

Objetivo: `channelId`, `departmentId`, `status`, `assignedToId` valerem em todo o dashboard. Há **dois formatos de where** nos métodos do service:

- **Formato A — where direto de Conversation** (usa `this.convScope(assignedToId)`): `getOverview`, `getVolumeByDay`, `getVolumeByChannel`, `getVolumeByStatus`, `getKpiSparklines`, `getVolumeFlow`, `getPeakHours`, `getBotPerformance`, `getReopens`, `getAgentPerformance`.
- **Formato B — where via relação `conversation: {...}`** (usa `this.relScope(assignedToId)`): `getMessagesFlow`, `getTopTags`, `getCsatBreakdown`.

**Files:**
- Modify: `src/modules/dashboard/dashboard.service.ts`
- Modify: `src/modules/dashboard/dashboard.controller.ts`
- Test: `src/modules/dashboard/dashboard.service.spec.ts`

- [ ] **Step 1: Test — filtros aplicados no getVolumeByDay (representante do Formato A)**

Adicionar ao spec:

```ts
describe('DashboardService filtros nos endpoints existentes', () => {
  const range = { from: new Date('2026-07-01'), to: new Date('2026-07-31') };

  it('getVolumeByDay aplica channelId/status no where', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new DashboardService({ conversation: { findMany } } as any);
    await service.getVolumeByDay('org-1', range, undefined, { channelId: 'ch-1', status: 'CLOSED' } as any);
    const where = findMany.mock.calls[0][0].where;
    expect(where.channelId).toBe('ch-1');
    expect(where.status).toBe('CLOSED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn jest dashboard.service.spec -t "filtros nos endpoints"`
Expected: FAIL — where sem `channelId` (assinatura ainda não aceita filtros).

- [ ] **Step 3: Implementar — assinatura opcional `filters` nos métodos**

Para **cada** método do Formato A, adicionar um 4º parâmetro `filters: ConvFilters = {}` e trocar a construção do `where` para passar por `applyConvFilters`. Exemplo concreto em `getVolumeByDay`:

```ts
async getVolumeByDay(
  organizationId: string,
  range: DateRange,
  assignedToId?: string,
  filters: ConvFilters = {},
) {
  const where = this.applyConvFilters(
    { organizationId, createdAt: { gte: range.from, lte: range.to } },
    filters,
    assignedToId,
  );
  const conversations = await this.prisma.conversation.findMany({
    where: where as Prisma.ConversationWhereInput,
    select: { createdAt: true },
  });
  // ...resto igual
}
```

Nota importante: onde hoje o método usa `...this.convScope(assignedToId)` no where, substituir por `applyConvFilters(base, filters, assignedToId)` — o `scope` (assignedToId do AGENT) continua tendo precedência sobre `filters.assignedToId` (RN-05 preservado). Onde há sub-queries (ex.: `prevWhere`, contagens de status), aplicar `applyConvFilters` na mesma base.

Para os métodos do **Formato B**, envolver o filtro dentro de `conversation: {...}`. Criar um segundo helper:

```ts
private applyRelFilters(filters: ConvFilters, scope?: string): Record<string, unknown> {
  const rel: Record<string, unknown> = {};
  if (filters.channelId) rel.channelId = filters.channelId;
  if (filters.departmentId) rel.departmentId = filters.departmentId;
  if (filters.status) rel.status = filters.status;
  const assigned = scope ?? filters.assignedToId;
  if (assigned) rel.assignedToId = assigned;
  return rel;
}
```

E nos métodos B (ex.: `getMessagesFlow`), trocar `conversation: { organizationId, ...this.relScope(assignedToId) }` por `conversation: { organizationId, ...this.applyRelFilters(filters, assignedToId) }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn jest dashboard.service.spec`
Expected: PASS.

- [ ] **Step 5: Threading no controller**

Em `dashboard.controller.ts`, adicionar `@Query` para `channelId`, `departmentId`, `status`, `assignedToId` em cada endpoint existente e montar o `ConvFilters` para passar como 4º argumento. Exemplo em `getVolumeByDay`:

```ts
@Get('volume-by-day')
@ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
@ApiQuery({ name: 'channelId', required: false }) @ApiQuery({ name: 'departmentId', required: false })
@ApiQuery({ name: 'status', required: false }) @ApiQuery({ name: 'assignedToId', required: false })
getVolumeByDay(
  @CurrentOrg('id') orgId: string,
  @CurrentUser('id') userId: string,
  @CurrentUserRole() role: OrgRole,
  @Query('from') from?: string,
  @Query('to') to?: string,
  @Query('channelId') channelId?: string,
  @Query('departmentId') departmentId?: string,
  @Query('status') status?: string,
  @Query('assignedToId') assignedToId?: string,
) {
  const f = this.parseLeadsFilter(from, to, channelId, departmentId, status, assignedToId);
  return this.service.getVolumeByDay(orgId, this.parseRange(from, to), this.assignmentScope(userId, role), f);
}
```

Aplicar o mesmo padrão de `@Query` + passar `f` (que é `LeadsFilter`, superset de `ConvFilters`) aos demais endpoints. `getVolumeByStatus` (sem range) recebe só os filtros de `ConvFilters`.

- [ ] **Step 6: Build**

Run: `yarn build`
Expected: verde.

- [ ] **Step 7: Commit**

```bash
git add src/modules/dashboard/
git commit -m "feat(dashboard): filtros (canal/depto/status/vendedor) em todos os endpoints"
```

---

## Task 5: Serviço web — `getLeadsReport` + filtros em todos os métodos

**Files:**
- Modify: `src/features/dashboard/services/dashboard.service.ts`

- [ ] **Step 1: Adicionar tipo de filtros e interface do relatório**

No topo do arquivo (após o `import`):

```ts
export interface DashboardFilters {
  from?: string;
  to?: string;
  channelId?: string;
  departmentId?: string;
  status?: string;
  assignedToId?: string;
}

export interface LeadsReport {
  newLeads: number;
  proactiveLeads: number;
  respondedLeads: number;
  respondedRate: number | null;
  bySeller: Array<{
    seller: { id: string; name: string; avatarUrl: string | null } | null;
    received: number;
    responded: number;
    open: number;
    closed: number;
    avgFirstResponseMin: number | null;
  }>;
}

function toParams(f: DashboardFilters = {}): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.from) p.from = f.from;
  if (f.to) p.to = f.to;
  if (f.channelId) p.channelId = f.channelId;
  if (f.departmentId) p.departmentId = f.departmentId;
  if (f.status) p.status = f.status;
  if (f.assignedToId) p.assignedToId = f.assignedToId;
  return p;
}
```

- [ ] **Step 2: Adicionar `getLeadsReport` e refatorar métodos para usar `toParams`**

Adicionar ao objeto `dashboardService`:

```ts
async getLeadsReport(filters?: DashboardFilters): Promise<LeadsReport> {
  const { data } = await api.get('/dashboard/leads', { params: toParams(filters) });
  return data.data;
},
```

E trocar a assinatura dos métodos existentes de `(from?, to?)` para `(filters?: DashboardFilters)`, usando `toParams(filters)`. Exemplo:

```ts
async getOverview(filters?: DashboardFilters): Promise<DashboardOverview> {
  const { data } = await api.get('/dashboard/overview', { params: toParams(filters) });
  return data.data;
},
```

Aplicar o mesmo a `getVolumeByDay`, `getVolumeByChannel`, `getKpiSparklines`, `getAgentPerformance`, `getVolumeFlow`, `getPeakHours`, `getMessagesFlow`, `getBotPerformance`, `getCsat`, `getReopens`. Para `getVolumeByStatus` e `getTopTags`, manter mas aceitar `filters` (o `limit` do topTags continua parâmetro separado, mesclado ao `toParams`).

- [ ] **Step 3: Verificar tipos**

Run: `cd chat-bullq-web && yarn tsc --noEmit`
Expected: pode acusar erros nos call-sites de `page.tsx` (assinatura mudou) — serão corrigidos na Task 7. Confirmar que o `dashboard.service.ts` em si não tem erro interno.

- [ ] **Step 4: Commit**

```bash
git add src/features/dashboard/services/dashboard.service.ts
git commit -m "feat(dashboard-web): getLeadsReport + filtros em todos os métodos"
```

---

## Task 6: Barra de filtros e seção de leads (web — componentes)

**Files:**
- Create: `src/features/dashboard/components/DashboardFilters.tsx`
- Create: `src/features/dashboard/components/LeadsSection.tsx`

- [ ] **Step 1: `DashboardFilters.tsx`**

Componente controlado. Recebe `filters` e `onChange`, além das listas para os dropdowns (canais, vendedores, departamentos) e `canFilterSeller` (só OWNER/ADMIN). Usar Tailwind seguindo o estilo dos cards do dashboard (`rounded-xl border border-zinc-200 bg-white ... dark:...`).

```tsx
'use client';

import type { DashboardFilters as Filters } from '@/features/dashboard/services/dashboard.service';

const PRESETS = [
  { label: '7 dias', days: 7 },
  { label: '30 dias', days: 30 },
  { label: '90 dias', days: 90 },
];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function DashboardFilters({
  filters, onChange, channels, sellers, departments, canFilterSeller,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  channels: Array<{ id: string; name: string }>;
  sellers: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  canFilterSeller: boolean;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const selectCls =
    'rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900';

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.days}
            onClick={() => set({ from: isoDaysAgo(p.days), to: new Date().toISOString().slice(0, 10) })}
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
          >
            {p.label}
          </button>
        ))}
      </div>

      <input type="date" value={filters.from ?? ''} onChange={(e) => set({ from: e.target.value })} className={selectCls} />
      <input type="date" value={filters.to ?? ''} onChange={(e) => set({ to: e.target.value })} className={selectCls} />

      <select value={filters.channelId ?? ''} onChange={(e) => set({ channelId: e.target.value || undefined })} className={selectCls}>
        <option value="">Todos os canais</option>
        {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      <select value={filters.departmentId ?? ''} onChange={(e) => set({ departmentId: e.target.value || undefined })} className={selectCls}>
        <option value="">Todos os departamentos</option>
        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>

      <select value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })} className={selectCls}>
        <option value="">Todos os status</option>
        {['PENDING', 'OPEN', 'WAITING', 'CLOSED', 'BOT'].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>

      {canFilterSeller && (
        <select value={filters.assignedToId ?? ''} onChange={(e) => set({ assignedToId: e.target.value || undefined })} className={selectCls}>
          <option value="">Todos os vendedores</option>
          {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `LeadsSection.tsx`**

```tsx
'use client';

import { UserPlus, MessageCircleReply, Inbox } from 'lucide-react';
import type { LeadsReport } from '@/features/dashboard/services/dashboard.service';

function StatCard({ label, value, sub, icon: Icon, accent }: {
  label: string; value: string | number; sub?: string; icon: React.ElementType; accent: string;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</span>
        <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: `${accent}1a`, color: accent }}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <span className="mt-3 text-3xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</span>
      {sub && <span className="mt-1 text-xs text-zinc-400">{sub}</span>}
    </div>
  );
}

export function LeadsSection({ report }: { report?: LeadsReport }) {
  if (!report) return null;
  const fila = report.bySeller.find((s) => s.seller === null);
  const vendedores = report.bySeller.filter((s) => s.seller !== null);

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Leads / Distribuição</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Novos leads" value={report.newLeads} icon={UserPlus} accent="#10b981" />
        <StatCard
          label="Responderam a 1ª msg"
          value={report.respondedRate !== null ? `${report.respondedRate}%` : '—'}
          sub={`${report.respondedLeads} de ${report.proactiveLeads} leads proativos`}
          icon={MessageCircleReply}
          accent="#3b82f6"
        />
        <StatCard label="Na fila (não distribuídos)" value={fila?.received ?? 0} icon={Inbox} accent="#f59e0b" />
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-3">Vendedor</th>
              <th className="px-4 py-3 text-right">Recebidos</th>
              <th className="px-4 py-3 text-right">Respondidos</th>
              <th className="px-4 py-3 text-right">Em aberto</th>
              <th className="px-4 py-3 text-right">Fechados</th>
              <th className="px-4 py-3 text-right">TMR 1ª resp.</th>
            </tr>
          </thead>
          <tbody>
            {vendedores.map((s) => (
              <tr key={s.seller!.id} className="border-b border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">{s.seller!.name}</td>
                <td className="px-4 py-3 text-right tabular-nums">{s.received}</td>
                <td className="px-4 py-3 text-right tabular-nums">{s.responded}</td>
                <td className="px-4 py-3 text-right tabular-nums">{s.open}</td>
                <td className="px-4 py-3 text-right tabular-nums">{s.closed}</td>
                <td className="px-4 py-3 text-right tabular-nums">{s.avgFirstResponseMin !== null ? `${s.avgFirstResponseMin} min` : '—'}</td>
              </tr>
            ))}
            {fila && fila.received > 0 && (
              <tr className="bg-amber-50/50 dark:bg-amber-950/20">
                <td className="px-4 py-3 font-medium text-amber-700 dark:text-amber-500">Na fila / não distribuídos</td>
                <td className="px-4 py-3 text-right tabular-nums">{fila.received}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fila.responded}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fila.open}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fila.closed}</td>
                <td className="px-4 py-3 text-right text-zinc-400">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Verificar tipos dos componentes**

Run: `yarn tsc --noEmit`
Expected: sem novos erros nos dois arquivos criados (erros pré-existentes em `page.tsx` ainda ok até Task 7).

- [ ] **Step 4: Commit**

```bash
git add src/features/dashboard/components/DashboardFilters.tsx src/features/dashboard/components/LeadsSection.tsx
git commit -m "feat(dashboard-web): componentes de filtro e seção de leads"
```

---

## Task 7: Integrar na página (web)

**Files:**
- Modify: `src/app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Estado de filtros + fontes de dropdown**

No componente da página, adicionar:

```tsx
import { useState } from 'react';
import { DashboardFilters } from '@/features/dashboard/components/DashboardFilters';
import { LeadsSection } from '@/features/dashboard/components/LeadsSection';
import type { DashboardFilters as Filters } from '@/features/dashboard/services/dashboard.service';

const DEFAULT_FILTERS: Filters = {
  from: (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })(),
  to: new Date().toISOString().slice(0, 10),
};
```

Dentro do componente:

```tsx
const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
```

Buscar as listas dos dropdowns via serviços existentes. Verificar os nomes exatos:
- **Canais**: `src/features/channels/services/channels.service.ts` (função de listagem — usar a existente, ex. `channelsService.list()`).
- **Vendedores**: `src/features/settings/services/members.service.ts` (listar membros; filtrar papel AGENT).
- **Departamentos**: procurar serviço/endpoint de departamentos; se não houver no web, ocultar o dropdown de departamento passando `departments={[]}` (o `<select>` só terá "Todos"). NÃO inventar endpoint — deixar vazio se não existir.
- **Papel do usuário**: obter role atual (OWNER/ADMIN/AGENT) do hook/contexto de auth existente para setar `canFilterSeller`.

```tsx
const { data: channels } = useQuery({
  queryKey: ['channels-list', orgId],
  queryFn: () => channelsService.list(),
});
const { data: members } = useQuery({
  queryKey: ['members-list', orgId],
  queryFn: () => membersService.list(),
});
const sellers = (members ?? []).filter((m) => m.role === 'AGENT').map((m) => ({ id: m.userId ?? m.id, name: m.name }));
const canFilterSeller = currentRole === 'OWNER' || currentRole === 'ADMIN';
```

- [ ] **Step 2: Injetar `filters` em TODAS as queries**

Trocar cada `queryFn` para passar `filters` e incluir `filters` na `queryKey` (para refetch ao mudar). Exemplo:

```tsx
const { data: overview, isLoading: loadingOverview } = useQuery({
  queryKey: ['dashboard-overview', orgId, filters],
  queryFn: () => dashboardService.getOverview(filters),
});
```

Aplicar a mesma troca (`, filters` na key + `(filters)` na queryFn) para: sparklines, volumeFlow, messagesFlow, peakHours, volumeByChannel, botPerf, topTags (`getTopTags(filters)`), agents, csat, reopens. Adicionar a nova query:

```tsx
const { data: leads } = useQuery({
  queryKey: ['dashboard-leads', orgId, filters],
  queryFn: () => dashboardService.getLeadsReport(filters),
});
```

- [ ] **Step 3: Renderizar a barra e a seção**

Logo abaixo do cabeçalho da página (antes dos KPIs), inserir:

```tsx
<DashboardFilters
  filters={filters}
  onChange={setFilters}
  channels={(channels ?? []).map((c) => ({ id: c.id, name: c.name }))}
  sellers={sellers}
  departments={[]}
  canFilterSeller={canFilterSeller}
/>
```

E onde fizer sentido no layout (ex.: logo após os KPIs de topo, antes de gráficos), inserir:

```tsx
<LeadsSection report={leads} />
```

- [ ] **Step 4: Verificar tipos e build**

Run: `yarn tsc --noEmit && yarn build`
Expected: verde. Corrigir call-sites que ainda usam a assinatura antiga `(from, to)`.

- [ ] **Step 5: Verificação visual**

Rodar o app (skill `run` ou `yarn dev`), abrir `/dashboard`:
- Barra de filtros aparece; trocar preset/canal/status refaz as queries e atualiza números.
- Seção "Leads / Distribuição" mostra os 3 cards + tabela por vendedor com a linha "Na fila".
- Como AGENT (se testável): dropdown de vendedor some; só vê os próprios números.

- [ ] **Step 6: Commit**

```bash
git add src/app/(dashboard)/dashboard/page.tsx
git commit -m "feat(dashboard-web): barra de filtros + seção de leads na página"
```

---

## Verificação final

- [ ] `cd chat-bullq-api && yarn jest dashboard.service.spec` — todos verdes.
- [ ] `cd chat-bullq-api && yarn build` — verde.
- [ ] `cd chat-bullq-web && yarn tsc --noEmit && yarn build` — verde.
- [ ] Manual: filtros valem no dashboard inteiro; relatórios de lead corretos; RN-05 preservado (AGENT só vê o dele, sem dropdown de vendedor).

## Notas

- **Dois repos, duas branches:** API em `feat/lead-reports-dashboard`; criar branch correspondente no `chat-bullq-web` (ex. `feat/lead-reports-dashboard`) para as Tasks 5–7.
- **RN-05 é crítico:** nunca deixar o `assignedToId` do query param sobrepor o `scope` do AGENT. Os testes de `applyConvFilters` cobrem isso — não afrouxar.
- **Extensão opcional (fora do v1):** split proativo vs receptivo nos cards, caso o OFP seja majoritariamente receptivo e o número de "respondidos" fique pouco informativo.
