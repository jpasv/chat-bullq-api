import { Injectable } from '@nestjs/common';
import { ConversationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  looksLikeProtocol,
  normalizeSearchText,
  toPhoneSearch,
} from '../../../common/search/normalize-search';

export interface InboxFilters {
  organizationId: string;
  status?: ConversationStatus[];
  channelId?: string;
  /** Used by inbox views that pin multiple channels at once. Combines
   *  with accessibleChannelIds via intersection. */
  channelIds?: string[];
  /** Static list of conversation ids — used by inbox views built via
   *  bulk-action "create inbox from selection". When set, only these
   *  conversations match (still intersected with the other filters). */
  conversationIds?: string[];
  /** Filter by conversation kind: individual (1-on-1) vs group (WA group
   *  / IG group thread). Undefined = both. */
  kind?: 'INDIVIDUAL' | 'GROUP';
  /** Tag ids applied to the conversation OR its contact. ANY match. */
  tagIds?: string[];
  assignedToId?: string;
  search?: string;
  accessibleChannelIds?: string[];
  /**
   * Archive scope:
   *   - 'exclude' (default) — hide archived conversations from the list.
   *   - 'only'              — show only archived conversations.
   *   - 'any'               — ignore archive flag entirely.
   */
  archived?: 'exclude' | 'only' | 'any';
  /**
   * When true, only conversations with at least one inbound message newer
   * than the user's `lastReadAt` cursor (or with no read row at all) are
   * returned. Requires `currentUserId` — without it, the flag is a no-op.
   */
  unreadOnly?: boolean;
  /**
   * When true, only conversations marked `isStuck=true` pelo watchdog
   * (excederam `maxAttempts` sem resposta) são retornadas. Útil pro
   * filtro/widget do dashboard.
   */
  stuckOnly?: boolean;
  /**
   * Ids a excluir do resultado — usado pelo `findInbox` pra tirar da lista
   * paginada as conversas que já aparecem na seção "Fixadas" (per-user),
   * evitando duplicação entre as duas queries.
   */
  excludeConversationIds?: string[];
}

@Injectable()
export class ConversationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private readonly listInclude: Prisma.ConversationInclude = {
    contact: {
      select: {
        id: true,
        name: true,
        phone: true,
        avatarUrl: true,
        tags: { include: { tag: true } },
        // Canais do contato → deriva o JID do grupo p/ anexar o Projeto.
        channels: { select: { channelId: true, externalId: true } },
      },
    },
    channel: {
      select: { id: true, type: true, name: true },
    },
    assignedTo: {
      select: { id: true, name: true, avatarUrl: true },
    },
    messages: {
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: {
        id: true,
        type: true,
        content: true,
        direction: true,
        createdAt: true,
      },
    },
    tags: { include: { tag: true } },
    // `_count.messages` NÃO entra aqui: o Prisma resolve `_count` com um
    // LEFT JOIN num agregado da tabela `messages` inteira, o que custava
    // ~16s por carregamento da inbox. `attachMessageCounts` conta só as
    // conversas da página.
  };

  /**
   * Cruza um `where.id` que já possa existir (ex.: de `conversationIds` ou
   * do filtro `unreadOnly`) com uma nova lista de ids, em modo interseção
   * ('in') ou exclusão ('notIn'). Generaliza o cruzamento que o filtro
   * `unreadOnly` já precisava fazer sozinho, e é reaproveitado pra: excluir
   * da lista paginada as conversas fixadas (notIn) e restringir a query de
   * fixadas ao conjunto pinnedIds (in).
   */
  private foldIdConstraint(
    where: Prisma.ConversationWhereInput,
    ids: string[],
    mode: 'in' | 'notIn',
  ): Prisma.ConversationWhereInput {
    const existing =
      where.id && typeof where.id === 'object' && 'in' in where.id
        ? (where.id as { in: string[] }).in
        : null;
    if (mode === 'in') {
      return {
        ...where,
        id: { in: existing ? existing.filter((id) => ids.includes(id)) : ids },
      };
    }
    return {
      ...where,
      id: existing
        ? { in: existing.filter((id) => !ids.includes(id)) }
        : { notIn: ids },
    };
  }

  /**
   * Monta o `where` compartilhado pela lista paginada (findInbox) e pela
   * seção de fixadas (findPinned) — os dois precisam respeitar exatamente
   * os mesmos filtros (busca, canal, tags, grupos, não lidas) pra não
   * divergir. `null` significa "resultado vazio", equivalente aos antigos
   * `return { conversations: [], total: 0 }` espalhados pelo método.
   */
  private async resolveWhere(
    filters: InboxFilters,
    currentUserId?: string,
  ): Promise<Prisma.ConversationWhereInput | null> {
    if (
      filters.accessibleChannelIds !== undefined &&
      filters.accessibleChannelIds.length === 0
    ) {
      return null;
    }

    let where: Prisma.ConversationWhereInput = {
      organizationId: filters.organizationId,
      // Hide conversations from soft-deleted channels. ChannelsRepository.softDelete
      // already flags both the channel and its conversations as deleted, but the
      // inbox query never honoured that flag — so when a Zappfy instance was
      // removed and re-added (same provider token, new DB row), the old channel's
      // conversations kept showing up as phantom duplicates of the live ones.
      deletedAt: null,
    };

    // Archive scope. The default inbox hides archived conversations; an
    // explicit "Archived" view passes archived='only'; legacy callers that
    // don't care can pass 'any'.
    const archivedScope = filters.archived ?? 'exclude';
    if (archivedScope === 'exclude') where.isArchived = false;
    else if (archivedScope === 'only') where.isArchived = true;

    if (filters.status?.length) {
      where.status = filters.status.length === 1
        ? filters.status[0]
        : { in: filters.status };
    }
    // Resolve the effective channel filter:
    //   - filters.channelId  (single, from the topbar dropdown)
    //   - filters.channelIds (multiple, from an inbox view)
    //   - accessibleChannelIds (RBAC ceiling for AGENTs without ALL access)
    // Final set = (requested ∩ accessible). Empty set returns nothing.
    const requested =
      filters.channelIds && filters.channelIds.length > 0
        ? filters.channelIds
        : filters.channelId
          ? [filters.channelId]
          : null;

    if (filters.accessibleChannelIds !== undefined) {
      if (requested) {
        const allowed = requested.filter((id) =>
          filters.accessibleChannelIds!.includes(id),
        );
        if (allowed.length === 0) return null;
        where.channelId = allowed.length === 1 ? allowed[0] : { in: allowed };
      } else {
        where.channelId = { in: filters.accessibleChannelIds };
      }
    } else if (requested) {
      where.channelId =
        requested.length === 1 ? requested[0] : { in: requested };
    }
    if (filters.conversationIds !== undefined) {
      if (filters.conversationIds.length === 0) {
        return null;
      }
      where.id = { in: filters.conversationIds };
    }
    if (filters.kind === 'INDIVIDUAL') where.isGroup = false;
    else if (filters.kind === 'GROUP') where.isGroup = true;
    if (filters.tagIds && filters.tagIds.length > 0) {
      // Match conversations that carry ANY of the requested tags. Includes
      // tags applied directly on the conversation OR on its contact —
      // operators tag both ways and expect the inbox to surface either.
      where.OR = [
        ...(where.OR ?? []) as any[],
        { tags: { some: { tagId: { in: filters.tagIds } } } },
        { contact: { tags: { some: { tagId: { in: filters.tagIds } } } } },
      ];
    }
    if (filters.assignedToId) where.assignedToId = filters.assignedToId;
    if (filters.stuckOnly) where.isStuck = true;
    const searchTerm = filters.search?.trim();
    if (searchTerm) {
      // Nome comparado sem acento/maiúscula (search_name, índice trigram);
      // telefone só pelos dígitos e só quando o termo parece telefone;
      // protocolo (20261124-RONH6V) só quando o termo parece protocolo.
      // Varrer a tabela inteira deixava a busca em segundos e estourava a
      // memória compartilhada do Postgres (erro 53100).
      // Vai num AND próprio: o filtro de etiquetas acima também usa OR, e
      // atribuir where.OR aqui apagava ele.
      // Nome e telefone num só filtro de contato: vira um único
      // `contact_id IN (...)` que o Postgres resolve pelos índices trigram.
      // Dois IN separados num OR (ou o protocolo, que é coluna da própria
      // conversa) obrigam a varrer as conversas inteiras.
      const searchName = normalizeSearchText(searchTerm);
      const phone = toPhoneSearch(searchTerm);
      const contactOr: Prisma.ContactWhereInput[] = [];
      if (searchName) contactOr.push({ searchName: { contains: searchName } });
      if (phone) contactOr.push({ phone: { contains: phone } });
      const or: Prisma.ConversationWhereInput[] = [];
      if (contactOr.length > 0) or.push({ contact: { OR: contactOr } });
      if (looksLikeProtocol(searchTerm)) {
        or.push({ protocol: { contains: searchTerm, mode: 'insensitive' } });
      }
      if (or.length > 0) {
        const existingAnd = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [];
        where.AND = [...existingAnd, { OR: or }];
      }
    }

    // "Unread only" filter — materialize the exact set of conversation ids
    // that have at least one INBOUND message newer than this user's
    // ConversationRead.lastReadAt (or no read row at all). Doing this in SQL
    // lets the main paginated query filter by `id IN (...)` so skip/take and
    // the count() are honest. Previously this ran post-paging in JS, which
    // truncated each page to the unread subset of those 30 rows and made
    // pagination terminate early — unread conversations sitting past row 30
    // never surfaced.
    // Uma inbound só conta como não lida se for mais nova que (a) o cursor
    // de leitura DESTE usuário e (b) a última OUTBOUND da conversa — de
    // QUALQUER pessoa (operador, IA, ou echo do celular sem sender). Inbox
    // de atendimento é compartilhado: se alguém da equipe já respondeu, a
    // conversa não está mais pendente pra ninguém. Sem o critério (b),
    // conversas respondidas pela colega continuavam em "não lidas" de todo
    // o resto do time pra sempre (ConversationRead é per-user).
    // Trade-off consciente: "marcar como não lida" deixa de surtir efeito
    // quando a última mensagem da conversa é uma resposta da equipe.
    if (filters.unreadOnly && currentUserId) {
      const rows = await this.prisma.$queryRaw<{ conversation_id: string }[]>`
        SELECT DISTINCT m.conversation_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        LEFT JOIN conversation_reads cr
          ON cr.conversation_id = m.conversation_id
          AND cr.user_id = ${currentUserId}
        LEFT JOIN (
          SELECT mo.conversation_id, MAX(mo.created_at) AS last_outbound_at
          FROM messages mo
          JOIN conversations co ON co.id = mo.conversation_id
          WHERE co.organization_id = ${filters.organizationId}
            AND mo.direction = 'OUTBOUND'
          GROUP BY mo.conversation_id
        ) lo ON lo.conversation_id = m.conversation_id
        WHERE c.organization_id = ${filters.organizationId}
          AND c.deleted_at IS NULL
          AND m.direction = 'INBOUND'
          AND (cr.last_read_at IS NULL OR m.created_at > cr.last_read_at)
          AND (lo.last_outbound_at IS NULL OR m.created_at > lo.last_outbound_at)
      `;
      const unreadIds = rows.map((r) => r.conversation_id);
      if (unreadIds.length === 0) return null;
      where = this.foldIdConstraint(where, unreadIds, 'in');
      if ((where.id as { in: string[] }).in.length === 0) return null;
    }

    return where;
  }

  async findInbox(
    filters: InboxFilters,
    skip: number,
    take: number,
    currentUserId?: string,
  ) {
    const where = await this.resolveWhere(filters, currentUserId);
    if (where === null) return { conversations: [], total: 0 };

    // A seção "Fixadas" (findPinned) já mostra essas conversas fora da
    // paginação — exclui daqui pra não duplicar.
    const finalWhere = filters.excludeConversationIds?.length
      ? this.foldIdConstraint(where, filters.excludeConversationIds, 'notIn')
      : where;

    const [page, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where: finalWhere,
        include: this.listInclude,
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        skip,
        take,
      }),
      this.prisma.conversation.count({ where: finalWhere }),
    ]);
    const conversations = await this.attachMessageCounts(page);

    // Per-user unread counters. Caller passes currentUserId; the user's
    // ConversationRead row holds the lastReadAt cursor and we count INBOUND
    // messages newer than that cursor. Conversations the user never opened
    // get every inbound message counted as unread.
    const enriched = currentUserId
      ? await this.attachUnreadCounts(conversations, currentUserId)
      : conversations.map((c) => ({ ...c, unreadCount: 0 }));

    return { conversations: enriched, total };
  }

  /**
   * Conversas fixadas pelo usuário atual (per-user, tabela `ConversationPin`)
   * que ainda batem com os filtros correntes da inbox. Não paginado — pin é
   * limitado a `ConversationsService.MAX_PINNED_PER_USER` (hoje 50), então
   * cabe inteiro numa única query. Quem chama (`ConversationsService.
   * findPinnedInbox`) sempre passa `archived: 'exclude'`.
   */
  async findPinned(
    filters: InboxFilters,
    pinnedIds: string[],
    currentUserId?: string,
  ) {
    if (pinnedIds.length === 0) return [];
    const where = await this.resolveWhere(filters, currentUserId);
    if (where === null) return [];
    const finalWhere = this.foldIdConstraint(where, pinnedIds, 'in');

    const rows = await this.attachMessageCounts(
      await this.prisma.conversation.findMany({
        where: finalWhere,
        include: this.listInclude,
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        take: 200,
      }),
    );

    const enriched = currentUserId
      ? await this.attachUnreadCounts(rows, currentUserId)
      : rows.map((c) => ({ ...c, unreadCount: 0 }));

    return enriched.map((c) => ({ ...c, isPinnedByMe: true }));
  }

  /**
   * Total de mensagens por conversa, só das conversas recebidas. Devolve o
   * mesmo formato que o `include._count` do Prisma (`_count.messages`).
   */
  private async attachMessageCounts<T extends { id: string }>(
    conversations: T[],
  ): Promise<Array<T & { _count: { messages: number } }>> {
    if (conversations.length === 0) return [];
    const grouped = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: { conversationId: { in: conversations.map((c) => c.id) } },
      _count: { _all: true },
    });
    const totalByConv = new Map(
      grouped.map((g) => [g.conversationId, g._count._all]),
    );
    return conversations.map((c) => ({
      ...c,
      _count: { messages: totalByConv.get(c.id) ?? 0 },
    }));
  }

  private async attachUnreadCounts<
    T extends { id: string; createdAt: Date },
  >(conversations: T[], userId: string): Promise<Array<T & { unreadCount: number }>> {
    if (conversations.length === 0) return [];
    const ids = conversations.map((c) => c.id);
    const [reads, lastOutbounds] = await Promise.all([
      this.prisma.conversationRead.findMany({
        where: { userId, conversationId: { in: ids } },
        select: { conversationId: true, lastReadAt: true },
      }),
      this.prisma.message.groupBy({
        by: ['conversationId'],
        where: { conversationId: { in: ids }, direction: 'OUTBOUND' },
        _max: { createdAt: true },
      }),
    ]);
    const readByConv = new Map(
      reads.map((r) => [r.conversationId, r.lastReadAt]),
    );
    const outByConv = new Map(
      lastOutbounds.map((r) => [r.conversationId, r._max.createdAt]),
    );

    // Run the counts in parallel — bounded by `take` (≤ 30 typically).
    const counts = await Promise.all(
      conversations.map((c) => {
        // Mesmo critério do filtro unreadOnly acima: o badge conta inbound
        // mais novas que o MAIOR entre o cursor de leitura do usuário e a
        // última resposta da equipe — senão badge e filtro divergem.
        const read = readByConv.get(c.id);
        const out = outByConv.get(c.id);
        const cursor =
          read && out ? (read > out ? read : out) : (read ?? out);
        return this.prisma.message.count({
          where: {
            conversationId: c.id,
            direction: 'INBOUND',
            ...(cursor ? { createdAt: { gt: cursor } } : {}),
          },
        });
      }),
    );

    return conversations.map((c, i) => ({ ...c, unreadCount: counts[i] }));
  }

  /** Marks a conversation as read for a user up to the given message (or now). */
  async markAsRead(
    userId: string,
    conversationId: string,
    lastReadMessageId?: string,
  ) {
    return this.prisma.conversationRead.upsert({
      where: {
        userId_conversationId: { userId, conversationId },
      },
      create: {
        userId,
        conversationId,
        lastReadMessageId: lastReadMessageId ?? null,
        lastReadAt: new Date(),
      },
      update: {
        lastReadMessageId: lastReadMessageId ?? null,
        lastReadAt: new Date(),
      },
    });
  }

  /**
   * Marks a conversation as unread for a user. Slack/Gmail-style semantics:
   * we don't reset the entire history — we push `lastReadAt` to right before
   * the most recent INBOUND message so the badge shows ≥ 1 unread.
   * If there's no inbound message yet, drop the read row entirely.
   */
  async markAsUnread(userId: string, conversationId: string) {
    const lastInbound = await this.prisma.message.findFirst({
      where: { conversationId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });

    if (!lastInbound) {
      await this.prisma.conversationRead.deleteMany({
        where: { userId, conversationId },
      });
      return { lastReadAt: null as Date | null, unreadCount: 0 };
    }

    // 1ms before the last inbound — the count query uses `gt`, so this
    // makes that single message (and any later ones) count as unread.
    const newLastReadAt = new Date(lastInbound.createdAt.getTime() - 1);
    await this.prisma.conversationRead.upsert({
      where: { userId_conversationId: { userId, conversationId } },
      create: {
        userId,
        conversationId,
        lastReadMessageId: null,
        lastReadAt: newLastReadAt,
      },
      update: { lastReadMessageId: null, lastReadAt: newLastReadAt },
    });

    const unreadCount = await this.prisma.message.count({
      where: {
        conversationId,
        direction: 'INBOUND',
        createdAt: { gt: newLastReadAt },
      },
    });

    return { lastReadAt: newLastReadAt, unreadCount };
  }

  async isPinned(userId: string, conversationId: string): Promise<boolean> {
    const row = await this.prisma.conversationPin.findUnique({
      where: { userId_conversationId: { userId, conversationId } },
      select: { id: true },
    });
    return !!row;
  }

  async countPinned(userId: string): Promise<number> {
    return this.prisma.conversationPin.count({ where: { userId } });
  }

  async pin(userId: string, conversationId: string) {
    return this.prisma.conversationPin.upsert({
      where: { userId_conversationId: { userId, conversationId } },
      create: { userId, conversationId },
      update: {}, // já fixada — idempotente, mantém o pinnedAt original
    });
  }

  async unpin(userId: string, conversationId: string): Promise<void> {
    await this.prisma.conversationPin.deleteMany({ where: { userId, conversationId } });
  }

  async listPinnedIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.conversationPin.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    return rows.map((r) => r.conversationId);
  }

  async findById(id: string) {
    return this.prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: { include: { channels: true, tags: { include: { tag: true } } } },
        channel: true,
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
        department: true,
        tags: { include: { tag: true } },
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
  }

  async update(id: string, data: Prisma.ConversationUpdateInput) {
    return this.prisma.conversation.update({ where: { id }, data });
  }

  async countByStatus(organizationId: string, accessibleChannelIds?: string[]) {
    if (accessibleChannelIds !== undefined && accessibleChannelIds.length === 0) {
      return {} as Record<string, number>;
    }
    const counts = await this.prisma.conversation.groupBy({
      by: ['status'],
      where: {
        organizationId,
        deletedAt: null,
        ...(accessibleChannelIds !== undefined
          ? { channelId: { in: accessibleChannelIds } }
          : {}),
      },
      _count: true,
    });
    return counts.reduce(
      (acc, c) => ({ ...acc, [c.status]: c._count }),
      {} as Record<string, number>,
    );
  }
}
