import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageDirection,
  MessageContentType,
  MessageStatus,
  OrgRole,
} from '@prisma/client';
import { MessagesRepository } from './messages.repository';
import { SendMessageDto } from './dto/send-message.dto';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../../iam/channel-access/channel-access.service';
import { WatchdogService } from '../../routing/watchdog/watchdog.service';
import { SegmentReadService } from '../../segments/segment-read.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { resolveAssignmentScope } from '../conversations/conversation-scope';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly repository: MessagesRepository,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly channelAccess: ChannelAccessService,
    private readonly watchdog: WatchdogService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly segmentRead: SegmentReadService,
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

    // Resolve replyTo: dois caminhos possíveis dependendo de onde a chamada
    // veio. UI manda `replyToMessageId` (id interno) e a gente busca o
    // externalId + preview no banco. Server-to-server pode mandar `replyTo`
    // pronto. Garantimos que adapter/UI tenham os campos que precisam
    // (externalMessageId pra adapter, preview/senderName pra Instagram
    // fallback, e ambos pra metadata da nossa message renderizar quote).
    let replyTo:
      | {
          externalMessageId: string;
          previewText?: string;
          senderName?: string;
          /** Internal id, not sent to provider — só pra metadata. */
          messageId?: string;
        }
      | undefined;
    if (dto.replyToMessageId) {
      const original = await this.prisma.message.findFirst({
        where: { id: dto.replyToMessageId, conversationId: conversation.id },
        select: {
          id: true,
          externalId: true,
          content: true,
          type: true,
          senderName: true,
          direction: true,
          sender: { select: { name: true } },
        },
      });
      if (!original) {
        throw new NotFoundException('Reply target message not found');
      }
      if (!original.externalId) {
        // Sem externalId não dá pra mandar reply nativo (provider não
        // conhece nossa msg interna). Joga erro claro em vez de mandar
        // mensagem sem reply silenciosamente.
        throw new ForbiddenException(
          'Mensagem citada ainda não foi sincronizada com o provider — tente novamente em alguns segundos.',
        );
      }
      const c = (original.content ?? {}) as Record<string, any>;
      const previewText: string | undefined =
        (typeof c.text === 'string' && c.text) ||
        (typeof c.caption === 'string' && c.caption) ||
        `[${original.type.toLowerCase()}]`;
      replyTo = {
        externalMessageId: original.externalId,
        previewText,
        senderName:
          original.direction === 'INBOUND'
            ? (original.senderName ?? conversation.contact.name ?? undefined)
            : (original.sender?.name ?? original.senderName ?? undefined),
        messageId: original.id,
      };
    } else if (dto.replyTo?.externalMessageId) {
      replyTo = { externalMessageId: dto.replyTo.externalMessageId };
    }

    const message = await this.repository.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      type: dto.type as MessageContentType,
      content: dto.content,
      status: MessageStatus.QUEUED,
      senderId,
      // metadata.replyTo é consumido pela UI pra renderizar a quote box
      // em cima da bolha — sem isso o quote só apareceria no app do
      // cliente (WhatsApp/IG), nunca no nosso inbox.
      metadata: replyTo
        ? {
            replyTo: {
              messageId: replyTo.messageId,
              externalMessageId: replyTo.externalMessageId,
              previewText: replyTo.previewText,
              senderName: replyTo.senderName,
            },
          }
        : undefined,
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

    // Auto-assign: whoever replies owns the conversation. If the current
    // assignee is someone else (or null), flip to the sender. Same-sender
    // replies are a no-op. Yes, this can "steal" from a teammate — but the
    // alternative (a conversation stuck on an inactive assignee while
    // someone else is actively replying) is worse for accountability.
    const shouldAutoAssign = conversation.assignedToId !== senderId;

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        ...(shouldAutoAssign ? { assignedToId: senderId } : {}),
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

    // Humano respondeu — cancela qualquer timer de watchdog pendente e
    // zera o contador de tentativas. Se a IA estava paralisada e quem
    // resolveu foi a pessoa, conversa não deve aparecer como "presa".
    this.watchdog.cancelCheck(conversation.id).catch(() => undefined);

    // Replying = reading. The sender obviously saw the inbound stream
    // before typing — bump their lastReadAt so the unread badge resets
    // even if they never clicked the conversation first.
    await this.prisma.conversationRead.upsert({
      where: {
        userId_conversationId: {
          userId: senderId,
          conversationId: conversation.id,
        },
      },
      create: {
        userId: senderId,
        conversationId: conversation.id,
        lastReadMessageId: message.id,
        lastReadAt: new Date(),
      },
      update: {
        lastReadMessageId: message.id,
        lastReadAt: new Date(),
      },
    });
    this.realtimeGateway.emitToUser(senderId, 'conversation:read', {
      conversationId: conversation.id,
      userId: senderId,
      lastReadAt: new Date(),
    });

    if (shouldAutoAssign) {
      this.realtimeGateway.emitToConversation(
        conversation.id,
        'conversation:assigned',
        {
          conversationId: conversation.id,
          assigneeId: senderId,
          reason: 'auto-assign-on-reply',
        },
      );
      this.realtimeGateway.emitToChannel(
        conversation.channelId,
        'conversation:assigned',
        {
          conversationId: conversation.id,
          assigneeId: senderId,
          reason: 'auto-assign-on-reply',
        },
      );
    }

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
          // Manda só o que o provider precisa: externalMessageId é
          // obrigatório (Zappfy/Cloud API), preview+sender são pro
          // fallback do Instagram. messageId interno fica fora do
          // payload pro adapter — só queria persistir na metadata.
          replyTo: replyTo
            ? {
                externalMessageId: replyTo.externalMessageId,
                previewText: replyTo.previewText,
                senderName: replyTo.senderName,
              }
            : undefined,
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

  /**
   * Marca uma mensagem como revogada (deletada pra todos). Tenta primeiro
   * propagar pro provider — se o canal suportar (Zappfy), o cliente final
   * vê "Esta mensagem foi apagada". Se o provider não suportar (Meta WA
   * Cloud, Instagram), continuamos marcando local pra a UI esconder, mas
   * o cliente final continua vendo a mensagem original no app dele.
   *
   * Regras:
   *  - só mensagens OUTBOUND podem ser revogadas (não dá pra apagar msg
   *    do cliente — não temos permissão na API dele)
   *  - precisa de externalId (msg ainda QUEUED sem externalId não foi
   *    enviada — basta deletar do banco em outro fluxo)
   *  - re-revoke é idempotente (retorna o mesmo estado)
   */
  async revokeForEveryone(
    messageId: string,
    organizationId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ): Promise<{
    messageId: string;
    revokedAt: Date;
    revokedBy: string;
    succeededRemote: boolean;
    remoteError: string | null;
  }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: { select: { id: true, organizationId: true, channelId: true } },
      },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, message.conversation.channelId);

    if (message.direction !== MessageDirection.OUTBOUND) {
      throw new BadRequestException(
        'Só dá pra deletar pra todos mensagens enviadas pelo time/IA. ' +
          'Mensagens do cliente não podem ser deletadas (não temos permissão no app dele).',
      );
    }

    if (message.revokedAt) {
      // Idempotente: já foi revogada antes — devolve o estado atual.
      return {
        messageId: message.id,
        revokedAt: message.revokedAt,
        revokedBy: message.revokedBy ?? actorId,
        succeededRemote: message.revokeSucceededRemote ?? false,
        remoteError: null,
      };
    }

    if (!message.externalId) {
      throw new BadRequestException(
        'Mensagem ainda não foi entregue ao provider — não tem como deletar pra todos. ' +
          'Tente de novo em alguns segundos ou apague localmente.',
      );
    }

    const channel = await this.prisma.channel.findUnique({
      where: { id: message.conversation.channelId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const adapter = this.adapterRegistry.getOutbound(channel.type);
    let succeededRemote = false;
    let remoteError: string | null = null;

    if (typeof adapter.deleteMessage === 'function') {
      try {
        await adapter.deleteMessage(channel, message.externalId);
        succeededRemote = true;
      } catch (err: unknown) {
        remoteError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Provider delete failed (channel=${channel.type} msg=${message.id}): ${remoteError}`,
        );
      }
    } else {
      remoteError = `Adapter ${channel.type} não implementa deleteMessage.`;
    }

    const revokedAt = new Date();
    await this.prisma.message.update({
      where: { id: message.id },
      data: {
        revokedAt,
        revokedBy: actorId,
        revokeSucceededRemote: succeededRemote,
      },
    });

    // Realtime: notifica todos os ouvintes da conversa pra re-renderizar
    // a bolha como "mensagem deletada" sem refresh.
    const payload = {
      messageId: message.id,
      conversationId: message.conversation.id,
      revokedAt: revokedAt.toISOString(),
      revokedBy: actorId,
      succeededRemote,
    };
    this.realtimeGateway.emitToConversation(
      message.conversation.id,
      'message:revoked',
      payload,
    );
    this.realtimeGateway.emitToChannel(
      message.conversation.channelId,
      'message:revoked',
      payload,
    );

    this.logger.log(
      `Message revoked: id=${message.id} channel=${channel.type} succeededRemote=${succeededRemote} actor=${actorId}`,
    );

    return {
      messageId: message.id,
      revokedAt,
      revokedBy: actorId,
      succeededRemote,
      remoteError,
    };
  }

  async findByConversation(
    conversationId: string,
    organizationId: string,
    page: number,
    limit: number,
    access: ChannelAccess = 'ALL',
    currentUserId?: string,
    role?: OrgRole,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
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

    const skip = (page - 1) * limit;
    // Grupo de segmento: une as mensagens das conversas-irmãs (mesmo grupo nos
    // outros números), deduplicando por messageid. Conversa normal segue o
    // caminho de conversa única.
    const siblingIds = await this.segmentRead.groupSiblingIds(conversationId);
    const { messages, total } = siblingIds
      ? await this.repository.findByConversationsUnioned(siblingIds, skip, limit)
      : await this.repository.findByConversation(conversationId, skip, limit);

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
