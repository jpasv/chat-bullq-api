import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageDirection,
  MessageContentType,
  MessageStatus,
} from '@prisma/client';
import { MessagesRepository } from './messages.repository';
import { SendMessageDto } from './dto/send-message.dto';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../../iam/channel-access/channel-access.service';

@Injectable()
export class MessagesService {
  constructor(
    private readonly repository: MessagesRepository,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly channelAccess: ChannelAccessService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async send(
    dto: SendMessageDto,
    senderId: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: dto.conversationId },
      include: {
        channel: true,
        contact: { include: { channels: true } },
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);

    const contactChannel = conversation.contact.channels.find(
      (cc) => cc.channelId === conversation.channelId,
    );
    if (!contactChannel) {
      throw new NotFoundException('Contact channel not found');
    }

    const message = await this.repository.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      type: dto.type as MessageContentType,
      content: dto.content,
      status: MessageStatus.QUEUED,
      senderId,
    });

    // Auto-pause the AI on this conversation when a human replies. Behavior
    // is org-configurable (aiAutoDisableOnHuman, default true). The human
    // is now driving — don't let the agent compete with them mid-thread.
    //
    // Skip auto-pause if the conversation already has an explicit force-off,
    // OR if a human explicitly forced AI ON for this conversation (aiEnabled=true).
    // Force-on means "I want the AI here even if I send messages" — usually a
    // human + AI cooperating in COPILOT-style mode.
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { aiAutoDisableOnHuman: true },
    });
    const shouldDisableAi =
      conversation.aiEnabled !== false &&
      conversation.aiEnabled !== true &&
      (org?.aiAutoDisableOnHuman ?? true);

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        ...(shouldDisableAi
          ? {
              aiEnabled: false,
              aiDisabledBy: senderId,
              aiDisabledAt: new Date(),
              activeAgentId: null,
            }
          : {}),
      },
    });

    if (shouldDisableAi) {
      this.realtimeGateway.emitToConversation(
        conversation.id,
        'conversation:ai-toggle',
        {
          conversationId: conversation.id,
          aiEnabled: false,
          actorId: senderId,
          reason: 'human-replied',
        },
      );
    }

    // Optimistic realtime: everyone in the channel/conversation sees the
    // outbound QUEUED row instantly, independent of the outbound worker
    // roundtrip. Channel-scoped so AGENTs without access to the channel
    // don't receive this event.
    this.realtimeGateway.emitToChannel(conversation.channelId, 'message:new', {
      message,
      conversationId: conversation.id,
      contactId: conversation.contactId,
    });
    this.realtimeGateway.emitToConversation(conversation.id, 'message:new', {
      message,
    });

    let outboundContent = dto.content;
    if (conversation.isGroup && dto.type === 'TEXT' && outboundContent.text) {
      const sender = await this.prisma.user.findUnique({
        where: { id: senderId },
        select: { name: true },
      });
      if (sender?.name) {
        outboundContent = {
          ...outboundContent,
          text: `*${sender.name}*\n${outboundContent.text}`,
        };
      }
    }

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: conversation.channelId,
        contactExternalId: contactChannel.externalId,
        message: {
          type: dto.type,
          content: outboundContent,
          replyTo: dto.replyTo,
        },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return message;
  }

  async findByConversation(
    conversationId: string,
    organizationId: string,
    page: number,
    limit: number,
    access: ChannelAccess = 'ALL',
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);

    const skip = (page - 1) * limit;
    const { messages, total } = await this.repository.findByConversation(
      conversationId,
      skip,
      limit,
    );

    return {
      messages,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
