import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AutomationTrigger, ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RatingsService } from '../../ratings/ratings.service';
import { OutboxService } from '../../automations/outbox/outbox.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import {
  CONVERSATION_CLOSED_JOB,
  ConversationClosedJobData,
} from '../pipeline/outbound-jobs.constants';

type Transition = {
  from: ConversationStatus;
  to: ConversationStatus;
};

const VALID_TRANSITIONS: Transition[] = [
  { from: ConversationStatus.PENDING, to: ConversationStatus.OPEN },
  { from: ConversationStatus.PENDING, to: ConversationStatus.BOT },
  { from: ConversationStatus.BOT, to: ConversationStatus.PENDING },
  { from: ConversationStatus.OPEN, to: ConversationStatus.WAITING },
  { from: ConversationStatus.OPEN, to: ConversationStatus.CLOSED },
  { from: ConversationStatus.WAITING, to: ConversationStatus.OPEN },
  { from: ConversationStatus.WAITING, to: ConversationStatus.CLOSED },
  { from: ConversationStatus.CLOSED, to: ConversationStatus.OPEN },
  { from: ConversationStatus.CLOSED, to: ConversationStatus.PENDING },
];

@Injectable()
export class ConversationFsmService {
  private readonly logger = new Logger(ConversationFsmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ratings: RatingsService,
    private readonly outbox: OutboxService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
    return VALID_TRANSITIONS.some((t) => t.from === from && t.to === to);
  }

  async transition(
    conversationId: string,
    to: ConversationStatus,
    actorId?: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    const from = conversation.status;

    if (!this.canTransition(from, to)) {
      throw new BadRequestException(
        `Invalid transition: ${from} → ${to}`,
      );
    }

    const updateData: Record<string, any> = { status: to };

    const closedAt = new Date();
    if (to === ConversationStatus.CLOSED) {
      updateData.closedAt = closedAt;
    }
    if (from === ConversationStatus.CLOSED && to !== ConversationStatus.CLOSED) {
      updateData.closedAt = null;
      updateData.reopenedAt = new Date();
      updateData.reopenedCount = { increment: 1 };
    }

    // Wrap mutation + audit + outbox emit in a single transaction. If
    // anything fails, none of it is visible — the automation engine never
    // sees a status change for a conversation whose update was rolled back.
    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: updateData,
      });

      await tx.conversationAuditLog.create({
        data: {
          conversationId,
          actorId,
          action: 'STATUS_CHANGED',
          fromValue: from,
          toValue: to,
          metadata: metadata || {},
        },
      });

      await this.outbox.enqueue(
        tx,
        AutomationTrigger.CONVERSATION_STATUS_CHANGED,
        {
          organizationId: conversation.organizationId,
          contactId: conversation.contactId,
          conversationId,
          channelId: conversation.channelId,
          actorId,
          fromStatus: from,
          toStatus: to,
        },
      );
    });

    this.logger.log(`Conversation ${conversationId}: ${from} → ${to}`);

    if (to === ConversationStatus.CLOSED) {
      this.ratings.requestRating(conversationId).catch((err) => {
        this.logger.warn(`Failed to request rating for ${conversationId}: ${err?.message}`);
      });
      // Fire-and-forget: o fechamento NUNCA falha por causa do provider.
      this.enqueueClosedCallback(conversationId, conversation.channelId, closedAt).catch(
        (err) =>
          this.logger.warn(
            `Failed to enqueue conversation-closed for ${conversationId}: ${err?.message ?? err}`,
          ),
      );
    }
  }

  /**
   * Canais cujo adapter implementa `onConversationClosed` (MEMBERS) recebem
   * o aviso de encerramento via job assíncrono na fila outbound (com retry).
   */
  async enqueueClosedCallback(
    conversationId: string,
    channelId: string,
    closedAt: Date,
  ): Promise<void> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { type: true },
    });
    if (!channel || !this.adapterRegistry.hasAdapter(channel.type)) return;
    const adapter = this.adapterRegistry.getOutbound(channel.type);
    if (typeof adapter.onConversationClosed !== 'function') return;

    const data: ConversationClosedJobData = {
      conversationId,
      channelId,
      closedAt: closedAt.toISOString(),
    };
    await this.outboundQueue.add(CONVERSATION_CLOSED_JOB, data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  async assign(
    conversationId: string,
    agentId: string,
    actorId?: string,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    const updates: Record<string, any> = { assignedToId: agentId };
    const willAlsoChangeStatus =
      conversation.status === ConversationStatus.PENDING;

    if (willAlsoChangeStatus) {
      updates.status = ConversationStatus.OPEN;
    }

    if (!conversation.firstResponseAt && willAlsoChangeStatus) {
      updates.firstResponseAt = new Date();
    }

    // Same-assignee no-op short-circuits the outbox emit. Without this,
    // every UI re-save would cycle the automation engine.
    const isNoOp = conversation.assignedToId === agentId;

    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: updates,
      });

      await tx.conversationAuditLog.create({
        data: {
          conversationId,
          actorId: actorId || agentId,
          action: 'ASSIGNED',
          fromValue: conversation.assignedToId,
          toValue: agentId,
        },
      });

      if (willAlsoChangeStatus) {
        await tx.conversationAuditLog.create({
          data: {
            conversationId,
            actorId: actorId || agentId,
            action: 'STATUS_CHANGED',
            fromValue: ConversationStatus.PENDING,
            toValue: ConversationStatus.OPEN,
          },
        });
      }

      if (!isNoOp) {
        await this.outbox.enqueue(
          tx,
          AutomationTrigger.CONVERSATION_ASSIGNED,
          {
            organizationId: conversation.organizationId,
            contactId: conversation.contactId,
            conversationId,
            channelId: conversation.channelId,
            actorId: actorId || agentId,
            fromAssigneeId: conversation.assignedToId,
            toAssigneeId: agentId,
          },
        );
      }

      if (willAlsoChangeStatus) {
        await this.outbox.enqueue(
          tx,
          AutomationTrigger.CONVERSATION_STATUS_CHANGED,
          {
            organizationId: conversation.organizationId,
            contactId: conversation.contactId,
            conversationId,
            channelId: conversation.channelId,
            actorId: actorId || agentId,
            fromStatus: ConversationStatus.PENDING,
            toStatus: ConversationStatus.OPEN,
          },
        );
      }
    });
  }
}
