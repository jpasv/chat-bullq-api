import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Conversation, ConversationStatus } from '@prisma/client';
import { ConversationsRepository, InboxFilters } from './conversations.repository';
import { ConversationFsmService } from './conversation-fsm.service';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { HistoryImportService } from '../pipeline/history-import.service';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../../iam/channel-access/channel-access.service';

const SYNC_MESSAGE_PAGE_SIZE = 50;
const SYNC_MAX_PAGES = 4;

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly repository: ConversationsRepository,
    private readonly fsm: ConversationFsmService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly historyImporter: HistoryImportService,
    private readonly channelAccess: ChannelAccessService,
  ) {}

  private broadcastUpdate(conversation: Conversation | null): void {
    if (!conversation) return;
    this.realtimeGateway.emitToChannel(
      conversation.channelId,
      'conversation:updated',
      { conversation },
    );
    this.realtimeGateway.emitToConversation(
      conversation.id,
      'conversation:updated',
      { conversation },
    );
  }

  async findInbox(
    organizationId: string,
    filters: {
      status?: string;
      channelId?: string;
      assignedToId?: string;
      search?: string;
    },
    page: number,
    limit: number,
    access: ChannelAccess = 'ALL',
  ) {
    const validStatuses = new Set(Object.values(ConversationStatus));
    const parsedStatuses = filters.status
      ?.split(',')
      .map((s) => s.trim() as ConversationStatus)
      .filter((s) => validStatuses.has(s));

    const inboxFilters: InboxFilters = {
      organizationId,
      status: parsedStatuses?.length ? parsedStatuses : undefined,
      channelId: filters.channelId,
      assignedToId: filters.assignedToId,
      search: filters.search,
      accessibleChannelIds: access === 'ALL' ? undefined : [...access],
    };

    const skip = (page - 1) * limit;
    const { conversations, total } = await this.repository.findInbox(
      inboxFilters,
      skip,
      limit,
    );

    return {
      conversations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, organizationId: string, access: ChannelAccess = 'ALL') {
    const conversation = await this.repository.findById(id);
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);
    return conversation;
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateConversationDto,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    const conversation = await this.findOne(id, organizationId, access);

    if (dto.assignedToId) {
      await this.fsm.assign(id, dto.assignedToId, actorId);
    }

    if (dto.status && dto.status !== conversation.status) {
      await this.fsm.transition(id, dto.status, actorId);
    }

    if (dto.departmentId) {
      await this.repository.update(id, { department: { connect: { id: dto.departmentId } } });
    }

    const updated = await this.repository.findById(id);
    this.broadcastUpdate(updated as Conversation | null);
    return updated;
  }

  async toggleAi(
    id: string,
    organizationId: string,
    enabled: boolean | null,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(id, organizationId, access);

    // Tri-state:
    //   null  = limpa override, conversa volta a seguir regras globais
    //   true  = força ON (sobrepõe kill switch e horário)
    //   false = força OFF
    const updated = await this.prisma.conversation.update({
      where: { id },
      data:
        enabled === null
          ? {
              aiEnabled: null,
              aiDisabledBy: null,
              aiDisabledAt: null,
            }
          : enabled === true
            ? {
                aiEnabled: true,
                aiDisabledBy: null,
                aiDisabledAt: null,
              }
            : {
                aiEnabled: false,
                aiDisabledBy: actorId,
                aiDisabledAt: new Date(),
                activeAgentId: null,
              },
    });

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: id,
        actorId,
        action:
          enabled === null
            ? 'AI_OVERRIDE_CLEARED'
            : enabled
              ? 'AI_FORCED_ON'
              : 'AI_FORCED_OFF',
        metadata: {},
      },
    });
    this.realtimeGateway.emitToConversation(id, 'conversation:ai-toggle', {
      conversationId: id,
      aiEnabled: enabled,
      actorId,
    });
    return updated;
  }

  async close(
    id: string,
    organizationId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(id, organizationId, access);
    await this.fsm.transition(id, ConversationStatus.CLOSED, actorId);
    const updated = await this.repository.findById(id);
    this.broadcastUpdate(updated as Conversation | null);
    return updated;
  }

  async reopen(
    id: string,
    organizationId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    const conversation = await this.findOne(id, organizationId, access);
    const target = conversation.assignedToId
      ? ConversationStatus.OPEN
      : ConversationStatus.PENDING;
    await this.fsm.transition(id, target, actorId);
    const updated = await this.repository.findById(id);
    this.broadcastUpdate(updated as Conversation | null);
    return updated;
  }

  async assignToMe(
    id: string,
    organizationId: string,
    userId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(id, organizationId, access);
    await this.fsm.assign(id, userId, userId);
    const updated = await this.repository.findById(id);
    this.broadcastUpdate(updated as Conversation | null);
    return updated;
  }

  async getStatusCounts(organizationId: string, access: ChannelAccess = 'ALL') {
    const accessibleIds = access === 'ALL' ? undefined : [...access];
    return this.repository.countByStatus(organizationId, accessibleIds);
  }

  /**
   * On-demand sync of a single conversation: pulls the latest messages from
   * the channel provider (e.g. Zappfy) and merges them with what we already
   * have locally. The webhook covers the steady state — this is the recovery
   * path for when an event was missed (provider downtime, webhook hiccup,
   * channel reconnected, etc.).
   */
  async syncMessages(id: string, organizationId: string, access: ChannelAccess = 'ALL') {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        channel: true,
        contact: {
          include: {
            channels: true,
          },
        },
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);

    const adapter = this.adapterRegistry.getHistorySync(conversation.channel.type);
    if (!adapter) {
      throw new BadRequestException(
        `Channel type ${conversation.channel.type} does not support sync`,
      );
    }

    const externalId = this.resolveExternalConversationId(conversation);
    if (!externalId) {
      throw new BadRequestException(
        'Cannot sync: conversation has no external chat id',
      );
    }

    let cursor: string | undefined;
    let imported = 0;
    let fetched = 0;
    let pages = 0;

    try {
      do {
        const result = await adapter.fetchMessages(
          conversation.channel,
          externalId,
          {},
          cursor,
          SYNC_MESSAGE_PAGE_SIZE,
        );
        fetched += result.messages.length;
        if (result.messages.length === 0) break;

        const res = await this.historyImporter.importMessages(
          conversation.channel,
          conversation.id,
          result.messages,
        );
        imported += res.imported;
        cursor = result.nextCursor;
        pages++;

        // Stop early once we hit a page where everything was already known —
        // the provider returns newest-first, so older pages can only be older
        // than what we already imported.
        if (res.imported === 0) break;
      } while (cursor && pages < SYNC_MAX_PAGES);
    } catch (err: any) {
      this.logger.error(
        `Failed to sync conversation ${id}: ${err.message}`,
        err.stack,
      );
      throw new BadRequestException(
        `Sync failed: ${err.response?.data?.message || err.message}`,
      );
    }

    if (imported > 0) {
      await this.historyImporter.notifyConversationImported(
        organizationId,
        conversation.id,
      );
    }

    this.logger.log(
      `Conversation ${id} synced: ${imported} new, ${fetched - imported} already known`,
    );

    return {
      imported,
      fetched,
      syncedAt: new Date().toISOString(),
    };
  }

  private resolveExternalConversationId(conversation: {
    channelId: string;
    metadata: any;
    contact: { channels: { channelId: string; externalId: string }[] };
  }): string | null {
    const fromMetadata =
      conversation.metadata &&
      typeof conversation.metadata === 'object' &&
      'externalConversationId' in conversation.metadata
        ? String((conversation.metadata as any).externalConversationId)
        : null;
    if (fromMetadata) return fromMetadata;

    const contactChannel = conversation.contact.channels.find(
      (c) => c.channelId === conversation.channelId,
    );
    return contactChannel?.externalId ?? null;
  }
}
