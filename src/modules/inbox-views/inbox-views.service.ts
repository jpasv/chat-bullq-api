import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ConversationsService } from '../messaging/conversations/conversations.service';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';
import {
  CreateInboxViewDto,
  InboxViewFiltersDto,
  UpdateInboxViewDto,
} from './dto/inbox-view.dto';

@Injectable()
export class InboxViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationsService: ConversationsService,
  ) {}

  /**
   * Built-in inbox views every user gets. Created lazily on first list()
   * so existing users pick them up without a backfill migration. Marked
   * with `metadata.builtin = true` so the UI can render an immutable
   * pin (no rename/delete).
   */
  private static readonly BUILTIN_VIEWS: Array<{
    name: string;
    icon: string;
    color: string;
    filters: Record<string, any>;
  }> = [
    {
      name: 'Não lidas',
      icon: 'MailOpen',
      color: '#ef4444',
      filters: { unreadOnly: true },
    },
    {
      name: 'Archived',
      icon: 'Archive',
      color: '#6b7280',
      filters: { archived: 'only' },
    },
  ];

  async list(organizationId: string, userId: string) {
    await this.ensureBuiltinViews(organizationId, userId);
    return this.prisma.inboxView.findMany({
      where: { organizationId, userId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Idempotently inserts the built-in views the first time a user lists
   * their inbox-views. Cheap because we only insert what's missing — and
   * the metadata flag identifies them across runs.
   */
  private async ensureBuiltinViews(organizationId: string, userId: string) {
    const existing = await this.prisma.inboxView.findMany({
      where: { organizationId, userId },
      select: { name: true, metadata: true },
    });
    const haveBuiltin = new Set(
      existing
        .filter(
          (v) =>
            v.metadata &&
            typeof v.metadata === 'object' &&
            (v.metadata as any).builtin === true,
        )
        .map((v) => v.name),
    );

    const missing = InboxViewsService.BUILTIN_VIEWS.filter(
      (b) => !haveBuiltin.has(b.name),
    );
    if (missing.length === 0) return;

    const max = await this.prisma.inboxView.findFirst({
      where: { userId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    let nextOrder = (max?.order ?? -1) + 1;

    for (const b of missing) {
      await this.prisma.inboxView.create({
        data: {
          organizationId,
          userId,
          name: b.name,
          icon: b.icon,
          color: b.color,
          filters: b.filters as object,
          metadata: { builtin: true } as object,
          order: nextOrder++,
        },
      });
    }
  }

  async findOne(id: string, organizationId: string, userId: string) {
    const view = await this.prisma.inboxView.findUnique({ where: { id } });
    if (!view) throw new NotFoundException('Inbox view not found');
    if (view.organizationId !== organizationId || view.userId !== userId) {
      throw new ForbiddenException();
    }
    return view;
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateInboxViewDto,
  ) {
    const max = await this.prisma.inboxView.findFirst({
      where: { userId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const nextOrder = dto.order ?? (max?.order ?? -1) + 1;

    return this.prisma.inboxView.create({
      data: {
        organizationId,
        userId,
        name: dto.name,
        icon: dto.icon ?? null,
        color: dto.color ?? null,
        filters: (dto.filters ?? {}) as object,
        order: nextOrder,
      },
    });
  }

  async update(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateInboxViewDto,
  ) {
    await this.findOne(id, organizationId, userId);
    return this.prisma.inboxView.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.filters !== undefined
          ? { filters: dto.filters as object }
          : {}),
        ...(dto.order !== undefined ? { order: dto.order } : {}),
      },
    });
  }

  async remove(id: string, organizationId: string, userId: string) {
    await this.findOne(id, organizationId, userId);
    await this.prisma.inboxView.delete({ where: { id } });
  }

  async reorder(organizationId: string, userId: string, ids: string[]) {
    const owned = await this.prisma.inboxView.findMany({
      where: { organizationId, userId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new ForbiddenException('Some ids do not belong to this user');
    }
    await this.prisma.$transaction(
      ids.map((id, idx) =>
        this.prisma.inboxView.update({
          where: { id },
          data: { order: idx },
        }),
      ),
    );
  }

  /**
   * Apply a view's filters and return a paginated conversation list. Reuses
   * the existing ConversationsService.findInbox for parity with the default
   * inbox query.
   *
   * `overrides` = filtros locais do user passados pela toolbar (ex: ligar
   * "Não lidas" dentro de uma view de canal específico, ou filtrar por tag
   * em cima de uma view de "Pendentes"). Regra: parâmetro presente vence
   * o filtro salvo da view. View é baseline, query string é override.
   */
  async findConversations(
    id: string,
    organizationId: string,
    userId: string,
    access: ChannelAccess,
    page: number,
    limit: number,
    extraSearch?: string,
    overrides?: {
      unread?: string;
      archived?: string;
      groups?: string;
      channelId?: string;
      tagIds?: string;
      assignedToId?: string;
      stuck?: string;
    },
    role?: OrgRole,
  ) {
    const view = await this.findOne(id, organizationId, userId);
    const filters = (view.filters ?? {}) as InboxViewFiltersDto;

    // Resolve "me"/"none"/"any" tokens against the current user.
    let assignedToId: string | undefined;
    if (filters.assignedTo === 'me') assignedToId = userId;
    else if (filters.assignedTo === 'none') assignedToId = 'null';
    else if (filters.assignedTo && filters.assignedTo !== 'any')
      assignedToId = filters.assignedTo;

    const status = filters.statuses?.length
      ? filters.statuses.join(',')
      : undefined;

    // ─── Merge overrides ─────────────────────────────────────────
    // Cada override só sobrepõe quando o user mandou algo explícito.
    // String vazia em archived/groups conta como "não passou".
    const ov = overrides ?? {};

    const finalUnread =
      ov.unread !== undefined
        ? ov.unread === 'true' || ov.unread === '1'
        : (filters.unreadOnly ?? false);

    const finalArchived: 'exclude' | 'only' | 'any' | undefined =
      ov.archived === 'only' || ov.archived === 'any' || ov.archived === 'exclude'
        ? (ov.archived as 'exclude' | 'only' | 'any')
        : filters.archived;

    let finalKind = filters.kind;
    if (ov.groups === 'exclude') finalKind = 'INDIVIDUAL';
    else if (ov.groups === 'only') finalKind = 'GROUP';
    // groups='include' deixa undefined (mostra ambos)
    else if (ov.groups === 'include') finalKind = undefined;

    const finalChannelIds = ov.channelId
      ? [ov.channelId]
      : filters.channelIds;

    // Tags: query param SUBSTITUI tags da view (não merge — mais previsível
    // pro user clicar e ver o filtro mudar). Se quiser combinar, salva uma
    // view custom com as tags certas.
    const overrideTagIds = ov.tagIds
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const finalTagIds =
      overrideTagIds && overrideTagIds.length > 0
        ? overrideTagIds
        : filters.tagIds;

    const finalAssignedToId = ov.assignedToId ?? assignedToId;
    const finalStuck = ov.stuck === 'true' || ov.stuck === '1';

    return this.conversationsService.findInbox(
      organizationId,
      {
        status,
        channelIds: finalChannelIds,
        conversationIds: filters.conversationIds,
        kind: finalKind,
        tagIds: finalTagIds,
        assignedToId: finalAssignedToId,
        search: extraSearch,
        archived: finalArchived,
        unreadOnly: finalUnread,
        stuckOnly: finalStuck || undefined,
      },
      page,
      limit,
      access,
      userId,
      role,
    );
  }
}
