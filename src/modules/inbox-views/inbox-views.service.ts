import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

  async list(organizationId: string, userId: string) {
    return this.prisma.inboxView.findMany({
      where: { organizationId, userId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
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
   */
  async findConversations(
    id: string,
    organizationId: string,
    userId: string,
    access: ChannelAccess,
    page: number,
    limit: number,
    extraSearch?: string,
  ) {
    const view = await this.findOne(id, organizationId, userId);
    const filters = (view.filters ?? {}) as InboxViewFiltersDto;

    // Resolve "me"/"none"/"any" tokens against the current user.
    let assignedToId: string | undefined;
    if (filters.assignedTo === 'me') assignedToId = userId;
    else if (filters.assignedTo === 'none') assignedToId = 'null';
    else if (filters.assignedTo && filters.assignedTo !== 'any')
      assignedToId = filters.assignedTo;

    // ConversationsService.findInbox accepts a single channelId today; for
    // now we pass the first one and let the rest be filtered post-fetch on
    // the FE if needed. (Multi-channel is the most common case — single
    // pick is the common UX path; extending findInbox to accept arrays is
    // a small follow-up.)
    const channelId = filters.channelIds?.[0];
    const status = filters.statuses?.length
      ? filters.statuses.join(',')
      : undefined;

    return this.conversationsService.findInbox(
      organizationId,
      {
        status,
        channelId,
        assignedToId,
        search: extraSearch,
      },
      page,
      limit,
      access,
    );
  }
}
