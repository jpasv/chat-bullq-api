import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Conversation, ConversationStatus, OrgRole } from '@prisma/client';
import { ConversationsRepository, InboxFilters } from './conversations.repository';
import { resolveAssignmentScope } from './conversation-scope';
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
import { AgentRouterService } from '../../ai-agents/router/agent-router.service';
import { AiAgentRunnerService } from '../../ai-agents/runner/agent-runner.service';
import { SegmentReadService } from '../../segments/segment-read.service';
import { ProjectsService } from '../../projects/projects.service';
import { deriveGroupJid } from '../../segments/group-jid.util';

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
    private readonly agentRouter: AgentRouterService,
    private readonly agentRunner: AiAgentRunnerService,
    private readonly segmentRead: SegmentReadService,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * Anexa o `project` (resumo) às conversas de grupo — uma consulta em lote por
   * JID. Mutação in-place (mesma referência) para reusar nos vários retornos.
   */
  private async attachProjects<
    T extends {
      organizationId: string;
      isGroup: boolean;
      channelId: string;
      contact?: { channels?: { channelId: string; externalId: string }[] } | null;
    },
  >(organizationId: string, conversations: T[]): Promise<T[]> {
    const jidByConv = new Map<T, string>();
    for (const c of conversations) {
      if (!c.isGroup) continue;
      const jid = deriveGroupJid(c);
      if (jid) jidByConv.set(c, jid);
    }
    if (jidByConv.size === 0) return conversations;
    const map = await this.projects.attachByJids(
      organizationId,
      Array.from(new Set(jidByConv.values())),
    );
    for (const [conv, jid] of jidByConv) {
      (conv as Record<string, unknown>).project = map.get(jid) ?? null;
    }
    return conversations;
  }

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
      channelIds?: string[];
      conversationIds?: string[];
      kind?: 'INDIVIDUAL' | 'GROUP';
      tagIds?: string[];
      assignedToId?: string;
      search?: string;
      archived?: 'exclude' | 'only' | 'any';
      unreadOnly?: boolean;
      stuckOnly?: boolean;
      segmentId?: string;
      hoppeId?: string;
      responsibleUserId?: string;
      projectStatus?: string;
    },
    page: number,
    limit: number,
    access: ChannelAccess = 'ALL',
    currentUserId?: string,
    role?: OrgRole,
  ) {
    const validStatuses = new Set(Object.values(ConversationStatus));
    const parsedStatuses = filters.status
      ?.split(',')
      .map((s) => s.trim() as ConversationStatus)
      .filter((s) => validStatuses.has(s));

    // Filtros que unificam por grupo POR LEITURA (Segmento ou Projeto): pegam
    // uma conversa representante por grupo (JID) e listam só essas — uma linha
    // por grupo, sem duplicar. Resolvem para conversationIds + channelIds; o
    // channelIds dá ao planner o índice (org,channel) e evita varrer o índice
    // de last_message_at (query O(segundos)).
    let conversationIds = filters.conversationIds;
    let resolvedChannelIds: string[] | undefined;
    let isGroupResolved = false;
    const projectFilter =
      filters.hoppeId || filters.responsibleUserId || filters.projectStatus
        ? {
            hoppeId: filters.hoppeId,
            responsibleUserId: filters.responsibleUserId,
            status: filters.projectStatus,
          }
        : null;

    if (filters.segmentId || projectFilter) {
      const { representativeIds, memberChannelIds } = filters.segmentId
        ? await this.segmentRead.groupRepresentativeIds(
            organizationId,
            filters.segmentId,
          )
        : await this.projects.resolveFilter(organizationId, projectFilter!);
      conversationIds = filters.conversationIds
        ? representativeIds.filter((id) => filters.conversationIds!.includes(id))
        : representativeIds;
      resolvedChannelIds = memberChannelIds;
      isGroupResolved = true;
      if (conversationIds.length === 0) {
        return {
          conversations: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
        };
      }
    }

    const inboxFilters: InboxFilters = {
      organizationId,
      status: parsedStatuses?.length ? parsedStatuses : undefined,
      // Em filtro de grupo (segmento/projeto) o canal vira o conjunto de
      // canais resolvidos (necessário pro plano da query); senão, o do usuário.
      channelId: isGroupResolved ? undefined : filters.channelId,
      channelIds: isGroupResolved ? resolvedChannelIds : filters.channelIds,
      conversationIds,
      kind: isGroupResolved ? 'GROUP' : filters.kind,
      tagIds: filters.tagIds,
      assignedToId: filters.assignedToId,
      enforceAssignedToId: currentUserId
        ? resolveAssignmentScope(role, currentUserId)
        : undefined,
      search: filters.search,
      accessibleChannelIds: access === 'ALL' ? undefined : [...access],
      archived: filters.archived,
      unreadOnly: filters.unreadOnly,
      stuckOnly: filters.stuckOnly,
    };

    const skip = (page - 1) * limit;
    const { conversations, total } = await this.repository.findInbox(
      inboxFilters,
      skip,
      limit,
      currentUserId,
    );

    await this.attachProjects(organizationId, conversations as any[]);

    return {
      conversations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(
    id: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
    currentUserId?: string,
    role?: OrgRole,
  ) {
    const conversation = await this.repository.findById(id);
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);
    if (
      currentUserId &&
      resolveAssignmentScope(role, currentUserId) &&
      conversation.assignedToId !== currentUserId
    ) {
      throw new ForbiddenException();
    }
    await this.attachProjects(organizationId, [conversation as any]);
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

    if (dto.subject !== undefined) {
      const trimmed = dto.subject.trim();
      await this.repository.update(id, {
        subject: trimmed.length > 0 ? trimmed : null,
      });
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

  /**
   * Manually trigger the AI agent to engage with this conversation right now.
   * Reads the latest inbound (or any latest message if no inbound) as the
   * trigger, calls the runner, and returns whatever final action the agent
   * decided. Skipped silently if the router rejects (paused, no agent, etc).
   */
  async engageAi(
    id: string,
    organizationId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ): Promise<{ engaged: boolean; reason?: string }> {
    const conversation = await this.findOne(id, organizationId, access);

    const decision = await this.agentRouter.shouldHandle(
      conversation as Conversation,
    );
    if (!decision.handle) {
      this.logger.log(
        `engageAi skipped for conv ${id}: ${decision.reason} (actor=${actorId})`,
      );
      return { engaged: false, reason: decision.reason };
    }

    // Pick the most recent inbound as the trigger so the agent has something
    // concrete to react to. Fall back to the latest message of any direction
    // (covers the case where the conversation was opened by the human).
    const triggerMessage =
      (await this.prisma.message.findFirst({
        where: { conversationId: id, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.message.findFirst({
        where: { conversationId: id },
        orderBy: { createdAt: 'desc' },
      }));

    if (!triggerMessage) {
      return { engaged: false, reason: 'no-messages' };
    }

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: id,
        actorId,
        action: 'AI_ENGAGED_MANUALLY',
        metadata: { triggerMessageId: triggerMessage.id },
      },
    });

    // Runner is async — kick it off in the background. The response payload
    // (new outbound message) will arrive via realtime + the run record will
    // appear in /ai-agents stats. Frontend can refetch right after the call.
    this.agentRunner
      .run({ conversation: conversation as Conversation, triggerMessage })
      .catch((err) =>
        this.logger.error(
          `engageAi run failed for conv ${id}: ${err?.message ?? err}`,
        ),
      );

    return { engaged: true };
  }

  /**
   * Manually pin a specific AI agent to this conversation and immediately
   * engage it. Use case: human says "vou te passar pra Lívia" via manual
   * message — the system can't infer that intent from text, so the operator
   * picks the agent in the UI and we (a) flip activeAgentId, (b) clear any
   * paused state (force AI on for this conversation), (c) fire the runner.
   */
  async setActiveAgent(
    id: string,
    organizationId: string,
    agentId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ): Promise<{ engaged: boolean; reason?: string; agentName?: string }> {
    const conversation = await this.findOne(id, organizationId, access);

    const agent = await this.prisma.aiAgent.findFirst({
      where: { id: agentId, organizationId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!agent) {
      throw new NotFoundException('Agent not found or not active in this org');
    }

    // Pin agent + force AI on for this conversation (override any pause).
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        activeAgentId: agentId,
        aiEnabled: true,
        aiDisabledBy: null,
        aiDisabledAt: null,
      },
    });

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: id,
        actorId,
        action: 'AI_AGENT_SET',
        fromValue: conversation.activeAgentId,
        toValue: agentId,
        metadata: { agentName: agent.name },
      },
    });

    this.broadcastUpdate(updated as Conversation);
    this.realtimeGateway.emitToConversation(id, 'conversation:ai-toggle', {
      conversationId: id,
      aiEnabled: true,
      activeAgentId: agentId,
      reason: 'agent-pinned',
    });

    // Pick latest inbound (preferred) or fallback to any latest message.
    const triggerMessage =
      (await this.prisma.message.findFirst({
        where: { conversationId: id, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.message.findFirst({
        where: { conversationId: id },
        orderBy: { createdAt: 'desc' },
      }));

    if (!triggerMessage) {
      return {
        engaged: false,
        reason: 'no-messages',
        agentName: agent.name,
      };
    }

    this.agentRunner
      .run({
        conversation: updated as Conversation,
        triggerMessage,
      })
      .catch((err) =>
        this.logger.error(
          `setActiveAgent run failed for conv ${id}: ${err?.message ?? err}`,
        ),
      );

    return { engaged: true, agentName: agent.name };
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

  /**
   * Hard delete — apaga a conversa de verdade. Cascade nas FKs (messages,
   * tags, audit logs, AI runs, reads, internal notes, rating, cards) cuida
   * dos dependentes. Operação irreversível: exige confirmação digitando o
   * nome ou telefone exato do contato.
   */
  async hardDelete(
    id: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
    confirm?: string,
  ) {
    const conversation = await this.findOne(id, organizationId, access);
    const expectedName = (conversation as any).contact?.name?.trim();
    const expectedPhone = (conversation as any).contact?.phone?.trim();
    const provided = (confirm ?? '').trim();
    if (!provided) {
      throw new BadRequestException(
        'Confirmação obrigatória: passe ?confirm=<nome ou telefone exato do contato>.',
      );
    }
    if (provided !== expectedName && provided !== expectedPhone) {
      throw new BadRequestException(
        'Confirmação não confere com o nome ou telefone do contato — apagamento abortado.',
      );
    }

    // FKs estão com onDelete: Cascade nos relacionados (messages,
    // conversation_tags, ai_agent_runs, conversation_reads, etc.) então
    // basta apagar a conversa que o resto cai junto.
    await this.prisma.conversation.delete({ where: { id } });

    this.realtimeGateway.emitToChannel(
      conversation.channelId,
      'conversation:deleted',
      { conversationId: id },
    );
    return { ok: true, id };
  }

  async setArchived(
    id: string,
    organizationId: string,
    archived: boolean,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(id, organizationId, access);
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: archived
        ? { isArchived: true, archivedAt: new Date(), archivedById: actorId }
        : { isArchived: false, archivedAt: null, archivedById: null },
    });

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: id,
        actorId,
        action: archived ? 'CONVERSATION_ARCHIVED' : 'CONVERSATION_UNARCHIVED',
        metadata: {},
      },
    });

    this.broadcastUpdate(updated as Conversation);
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
   * Marks a conversation as read for the current user. Upserts the
   * ConversationRead row with lastReadAt = now and emits a realtime
   * `conversation:read` event so any open client (other tab, mobile)
   * zeros the badge in real time.
   */
  async markAsRead(
    conversationId: string,
    organizationId: string,
    userId: string,
    access: ChannelAccess = 'ALL',
    lastReadMessageId?: string,
  ) {
    await this.findOne(conversationId, organizationId, access);
    const read = await this.repository.markAsRead(
      userId,
      conversationId,
      lastReadMessageId,
    );

    this.realtimeGateway.emitToUser(userId, 'conversation:read', {
      conversationId,
      userId,
      lastReadAt: read.lastReadAt,
    });

    return { ok: true, lastReadAt: read.lastReadAt };
  }

  /**
   * Per-user "mark as unread". Pushes lastReadAt before the latest inbound so
   * the conversation re-surfaces as unread for THIS user only. Other users'
   * read state is untouched.
   */
  async markAsUnread(
    conversationId: string,
    organizationId: string,
    userId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(conversationId, organizationId, access);
    const result = await this.repository.markAsUnread(userId, conversationId);

    this.realtimeGateway.emitToUser(userId, 'conversation:unread', {
      conversationId,
      userId,
      unreadCount: result.unreadCount,
    });

    return { ok: true, unreadCount: result.unreadCount };
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
