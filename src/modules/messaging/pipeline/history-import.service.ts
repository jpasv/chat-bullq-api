import { Injectable, Logger } from '@nestjs/common';
import {
  Channel,
  ConversationStatus,
  MessageContentType as PrismaContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  NormalizedHistoricalConversation,
  NormalizedHistoricalMessage,
} from '../../channel-hub/ports/types';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

export interface ConversationImportResult {
  conversationId: string;
  contactId: string;
  isNew: boolean;
}

export interface MessagesImportResult {
  imported: number;
  skipped: number;
}

@Injectable()
export class HistoryImportService {
  private readonly logger = new Logger(HistoryImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  async importConversation(
    channel: Channel,
    normalized: NormalizedHistoricalConversation,
  ): Promise<ConversationImportResult> {
    const contactId = await this.upsertContact(channel, normalized);

    const existing = await this.prisma.conversation.findFirst({
      where: {
        organizationId: channel.organizationId,
        channelId: channel.id,
        contactId,
        status: {
          in: [
            ConversationStatus.PENDING,
            ConversationStatus.OPEN,
            ConversationStatus.BOT,
            ConversationStatus.WAITING,
          ],
        },
      },
    });

    if (existing) {
      if (normalized.lastMessageAt && (!existing.lastMessageAt || normalized.lastMessageAt > existing.lastMessageAt)) {
        await this.prisma.conversation.update({
          where: { id: existing.id },
          data: { lastMessageAt: normalized.lastMessageAt },
        });
      }
      return { conversationId: existing.id, contactId, isNew: false };
    }

    const protocol = this.generateProtocol();
    const conversation = await this.prisma.conversation.create({
      data: {
        organizationId: channel.organizationId,
        channelId: channel.id,
        contactId,
        status:
          (normalized.unreadCount ?? 0) > 0
            ? ConversationStatus.PENDING
            : ConversationStatus.OPEN,
        protocol,
        isGroup: normalized.isGroup || false,
        lastMessageAt: normalized.lastMessageAt,
        metadata: {
          imported: true,
          externalConversationId: normalized.externalConversationId,
        },
      },
    });

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: conversation.id,
        action: 'CREATED',
        toValue: ConversationStatus.PENDING,
        metadata: { source: 'history_import' },
      },
    });

    return { conversationId: conversation.id, contactId, isNew: true };
  }

  async importMessages(
    channel: Channel,
    conversationId: string,
    messages: NormalizedHistoricalMessage[],
  ): Promise<MessagesImportResult> {
    if (messages.length === 0) return { imported: 0, skipped: 0 };

    const externalIds = messages.map((m) => m.externalMessageId).filter(Boolean);
    const existing = await this.prisma.message.findMany({
      where: {
        conversationId,
        externalId: { in: externalIds },
      },
      select: { externalId: true },
    });
    const existingSet = new Set(existing.map((e) => e.externalId));

    const toCreate = messages.filter(
      (m) => m.externalMessageId && !existingSet.has(m.externalMessageId),
    );

    if (toCreate.length === 0) {
      return { imported: 0, skipped: messages.length };
    }

    await this.prisma.message.createMany({
      data: toCreate.map((m) => ({
        conversationId,
        direction: m.direction,
        type: m.type as unknown as PrismaContentType,
        content: m.content as any,
        externalId: m.externalMessageId,
        status:
          m.direction === MessageDirection.OUTBOUND
            ? MessageStatus.SENT
            : MessageStatus.DELIVERED,
        senderName: m.senderName ?? null,
        sentAt: m.direction === MessageDirection.OUTBOUND ? m.timestamp : null,
        deliveredAt: m.direction === MessageDirection.INBOUND ? m.timestamp : null,
        createdAt: m.timestamp,
        metadata: {
          imported: true,
          rawPayload: m.rawPayload ? JSON.parse(JSON.stringify(m.rawPayload)) : null,
        },
      })),
      skipDuplicates: true,
    });

    const latestTimestamp = toCreate.reduce(
      (max, m) => (m.timestamp > max ? m.timestamp : max),
      new Date(0),
    );
    if (latestTimestamp.getTime() > 0) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: latestTimestamp },
      });
    }

    return { imported: toCreate.length, skipped: messages.length - toCreate.length };
  }

  async notifyConversationImported(
    organizationId: string,
    conversationId: string,
  ): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channelId: true },
    });
    if (!conv) return;
    this.realtimeGateway.emitToChannel(conv.channelId, 'conversation:imported', {
      conversationId,
    });
  }

  private async upsertContact(
    channel: Channel,
    normalized: NormalizedHistoricalConversation,
  ): Promise<string> {
    const existing = await this.prisma.contactChannel.findUnique({
      where: {
        uq_contact_channel_external: {
          channelId: channel.id,
          externalId: normalized.externalContactId,
        },
      },
      include: { contact: true },
    });

    if (existing) {
      const updates: Record<string, any> = {};
      if (normalized.contactName && normalized.contactName !== existing.profileName) {
        updates.profileName = normalized.contactName;
      }
      if (
        normalized.contactAvatarUrl &&
        normalized.contactAvatarUrl !== existing.profileAvatarUrl
      ) {
        updates.profileAvatarUrl = normalized.contactAvatarUrl;
      }
      if (Object.keys(updates).length > 0) {
        await this.prisma.contactChannel.update({
          where: { id: existing.id },
          data: updates,
        });
      }
      return existing.contactId;
    }

    const contact = await this.prisma.contact.create({
      data: {
        organizationId: channel.organizationId,
        name: normalized.contactName,
        phone: normalized.contactPhone,
        avatarUrl: normalized.contactAvatarUrl,
        channels: {
          create: {
            channelId: channel.id,
            externalId: normalized.externalContactId,
            profileName: normalized.contactName,
            profileAvatarUrl: normalized.contactAvatarUrl,
          },
        },
      },
    });

    return contact.id;
  }

  private generateProtocol(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${date}-${rand}`;
  }
}
