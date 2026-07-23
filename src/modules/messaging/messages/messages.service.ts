import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  Channel,
  ChannelType,
  MessageDirection,
  MessageContentType,
  MessageStatus,
} from '@prisma/client';
import { MessagesRepository } from './messages.repository';
import { SendMessageDto } from './dto/send-message.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { StartConversationDto } from '../conversations/dto/start-conversation.dto';
import { MediaResolverService } from './media-resolver.service';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../../iam/channel-access/channel-access.service';
import { WatchdogService } from '../../routing/watchdog/watchdog.service';
import { SegmentReadService } from '../../segments/segment-read.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { ContactResolverService } from '../pipeline/contact-resolver.service';
import { ConversationResolverService } from '../pipeline/conversation-resolver.service';

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
    private readonly contactResolver: ContactResolverService,
    private readonly conversationResolver: ConversationResolverService,
    private readonly mediaResolver: MediaResolverService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  /**
   * Operador inicia conversa ativa pelo painel com um cliente que pode nunca
   * ter tido histórico ("Nova conversa"). Instagram fica de fora: a política
   * da Meta não permite negócio iniciar DM com quem nunca interagiu (sem
   * template/opt-in não tem "cold start" via Graph API, diferente do
   * WhatsApp Oficial que aceita HSM aprovado).
   *
   * Resolve contato + conversa e delega pro `send()` de sempre — mesmo
   * enfileiramento, auto-assign e side-effects de qualquer mensagem manual.
   */
  async startConversation(
    dto: StartConversationDto,
    senderId: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
  ) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: dto.channelId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, channel.id);

    if (channel.type === ChannelType.INSTAGRAM) {
      throw new BadRequestException(
        'Não é possível iniciar conversa no Instagram: a política da Meta só ' +
          'permite mensagens dentro da janela de 24h após o cliente interagir ' +
          'primeiro — não existe envio "a frio" via API, nem com template.',
      );
    }

    const resolvedContact = await this.contactResolver.resolveManual(
      organizationId,
      channel.id,
      channel.type,
      dto.contact,
    );

    const resolvedConversation = await this.conversationResolver.resolveForOperator(
      organizationId,
      channel.id,
      resolvedContact.contactId,
      senderId,
      dto.subject,
    );

    return this.send(
      {
        conversationId: resolvedConversation.conversationId,
        type: dto.message.type,
        content: dto.message.content,
      },
      senderId,
      organizationId,
      access,
    );
  }

  async send(
    dto: SendMessageDto,
    senderId: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
    options?: {
      /** Não prefixar `*Nome*\n` no texto — usado no forward (verbatim). */
      skipSignature?: boolean;
      /** Marca a nova Message como encaminhada (a UI renderiza "Encaminhada"). */
      forwardedFrom?: { messageId: string; conversationId: string };
    },
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

    // metadata.replyTo é consumido pela UI pra renderizar a quote box em cima
    // da bolha; metadata.forwardedFrom marca a bolha como "Encaminhada". Ambos
    // são opcionais e independentes.
    const metadata: Record<string, any> = {};
    if (replyTo) {
      metadata.replyTo = {
        messageId: replyTo.messageId,
        externalMessageId: replyTo.externalMessageId,
        previewText: replyTo.previewText,
        senderName: replyTo.senderName,
      };
    }
    if (options?.forwardedFrom) {
      metadata.forwardedFrom = options.forwardedFrom;
    }

    const message = await this.repository.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      type: dto.type as MessageContentType,
      content: dto.content,
      status: MessageStatus.QUEUED,
      senderId,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
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
    // Assina com o nome de quem enviou. Vale também em conversa individual:
    // vários atendentes dividem o mesmo número, então sem isso o contato não
    // tem como saber com quem falou. Forward pula a assinatura (verbatim).
    if (!options?.skipSignature && dto.type === 'TEXT' && outboundContent.text) {
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

  /** Canais para os quais é permitido encaminhar (só WhatsApp). */
  private static readonly FORWARD_TARGET_TYPES: ChannelType[] = [
    ChannelType.WHATSAPP_ZAPPFY,
    ChannelType.WHATSAPP_OFFICIAL,
  ];

  /**
   * URL de mídia que o browser não toca e que o provider de destino não
   * conseguiria rebaixar: `.enc` da CDN da Meta. Mesma regra do front
   * (`use-resolved-media.ts`).
   */
  private looksUnplayableMedia(url: string): boolean {
    return /\.enc(\?|$)/i.test(url) || /mmg\.whatsapp\.net/i.test(url);
  }

  /**
   * Encaminha uma mensagem existente para uma ou mais conversas WhatsApp e/ou
   * números novos. Reconstrói o `content` da origem e reusa o `send()` de
   * sempre (fila outbound, realtime, auto-assign), marcando a nova mensagem
   * como encaminhada. Falha por-destino é isolada em `failed` — um destino
   * ruim não derruba os outros.
   */
  async forward(
    messageId: string,
    dto: ForwardMessageDto,
    senderId: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
  ): Promise<{
    sent: Awaited<ReturnType<MessagesService['send']>>[];
    failed: Array<{ target: string; reason: string }>;
  }> {
    const conversationIds = dto.conversationIds ?? [];
    const contacts = dto.contacts ?? [];
    if (conversationIds.length === 0 && contacts.length === 0) {
      throw new BadRequestException(
        'Informe ao menos uma conversa ou número de destino.',
      );
    }

    const source = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: {
          select: {
            id: true,
            organizationId: true,
            channelId: true,
            channel: true,
          },
        },
      },
    });
    if (!source) throw new NotFoundException('Message not found');
    if (source.conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, source.conversation.channelId);

    // Reconstrói o payload encaminhável (resolve mídia .enc se preciso).
    const payload = await this.buildForwardPayload(
      { id: source.id, type: source.type, externalId: source.externalId },
      source.conversation.channel,
      (source.content ?? {}) as Record<string, any>,
      organizationId,
      access,
    );

    const failed: Array<{ target: string; reason: string }> = [];
    const targetConversationIds: string[] = [];

    // Destinos: conversas existentes (validando canal WhatsApp).
    for (const conversationId of conversationIds) {
      try {
        const conv = await this.prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { channel: true },
        });
        if (!conv) throw new NotFoundException('Conversa de destino não encontrada');
        if (conv.organizationId !== organizationId) throw new ForbiddenException();
        this.channelAccess.assertChannelAccess(access, conv.channelId);
        this.assertWhatsappTarget(conv.channel.type);
        targetConversationIds.push(conv.id);
      } catch (err) {
        failed.push({ target: conversationId, reason: errorMessage(err) });
      }
    }

    // Destinos: números novos (mesmo fluxo do startConversation).
    for (const contact of contacts) {
      const label = contact.phone || contact.channelId;
      try {
        const channel = await this.prisma.channel.findUnique({
          where: { id: contact.channelId },
        });
        if (!channel) throw new NotFoundException('Canal de destino não encontrado');
        if (channel.organizationId !== organizationId) throw new ForbiddenException();
        this.channelAccess.assertChannelAccess(access, channel.id);
        this.assertWhatsappTarget(channel.type);

        const resolvedContact = await this.contactResolver.resolveManual(
          organizationId,
          channel.id,
          channel.type,
          { phone: contact.phone, name: contact.name },
        );
        const resolvedConversation =
          await this.conversationResolver.resolveForOperator(
            organizationId,
            channel.id,
            resolvedContact.contactId,
            senderId,
          );
        targetConversationIds.push(resolvedConversation.conversationId);
      } catch (err) {
        failed.push({ target: label, reason: errorMessage(err) });
      }
    }

    // Deduplica destinos (dois contatos podem resolver na mesma conversa).
    const uniqueTargets = [...new Set(targetConversationIds)];

    const sent: Awaited<ReturnType<MessagesService['send']>>[] = [];
    for (const conversationId of uniqueTargets) {
      try {
        const msg = await this.send(
          { conversationId, type: payload.type, content: payload.content },
          senderId,
          organizationId,
          access,
          {
            skipSignature: true,
            forwardedFrom: {
              messageId: source.id,
              conversationId: source.conversation.id,
            },
          },
        );
        sent.push(msg);
      } catch (err) {
        failed.push({ target: conversationId, reason: errorMessage(err) });
      }
    }

    if (sent.length === 0) {
      const reason = failed.map((f) => f.reason).join('; ') || 'destino inválido';
      throw new BadRequestException(`Não foi possível encaminhar: ${reason}`);
    }

    this.logger.log(
      `Message forwarded: source=${source.id} sent=${sent.length} failed=${failed.length} actor=${senderId}`,
    );

    return { sent, failed };
  }

  private assertWhatsappTarget(type: ChannelType): void {
    if (!MessagesService.FORWARD_TARGET_TYPES.includes(type)) {
      throw new BadRequestException(
        'Só é possível encaminhar para conversas/números WhatsApp.',
      );
    }
  }

  /**
   * Reconstrói `{ type, content }` a partir da mensagem de origem, pronto pra
   * reenviar. Para mídia, garante uma `mediaUrl` que o provider de destino
   * consiga baixar (resolve a `.enc` da Uazapi quando necessário).
   */
  private async buildForwardPayload(
    source: { id: string; type: MessageContentType; externalId: string | null },
    channel: Channel,
    content: Record<string, any>,
    organizationId: string,
    access: ChannelAccess,
  ): Promise<{ type: string; content: Record<string, any> }> {
    switch (source.type) {
      case MessageContentType.TEXT: {
        const text = typeof content.text === 'string' ? content.text : '';
        if (!text.trim()) {
          throw new BadRequestException('Mensagem de texto sem conteúdo pra encaminhar.');
        }
        // `mentions` de propósito fora: só faziam sentido no grupo de origem.
        return { type: MessageContentType.TEXT, content: { text } };
      }

      case MessageContentType.LOCATION:
        return {
          type: MessageContentType.LOCATION,
          content: {
            latitude: content.latitude,
            longitude: content.longitude,
            text: content.text,
          },
        };

      case MessageContentType.IMAGE:
      case MessageContentType.VIDEO:
      case MessageContentType.AUDIO:
      case MessageContentType.DOCUMENT:
      case MessageContentType.STICKER: {
        const mediaUrl = await this.resolveForwardMediaUrl(
          source,
          channel,
          content,
          organizationId,
          access,
        );
        const forwarded: Record<string, any> = { mediaUrl };
        if (content.mimeType) forwarded.mimeType = content.mimeType;
        if (content.fileName) forwarded.fileName = content.fileName;
        if (content.caption) forwarded.caption = content.caption;
        return { type: source.type, content: forwarded };
      }

      case MessageContentType.REACTION:
        throw new BadRequestException('Não dá pra encaminhar uma reação.');

      // TEMPLATE / INTERACTIVE / SYSTEM: sem reenvio 1:1 possível. Encaminha
      // a versão legível em texto quando existe.
      default: {
        const text = typeof content.text === 'string' ? content.text : '';
        if (text.trim()) {
          return { type: MessageContentType.TEXT, content: { text } };
        }
        throw new BadRequestException(
          `Mensagens do tipo "${source.type}" não podem ser encaminhadas.`,
        );
      }
    }
  }

  /**
   * URL de mídia pronta pra reenviar. Reusa a `mediaUrl` já tocável (mídia que
   * nós enviamos ou já resolvemos). Quando está vazia, usa o
   * `MediaResolverService` (resolve + cacheia). Quando é `.enc` cacheada, força
   * a resolução direto pelo adapter (o resolver devolveria a `.enc` do cache).
   */
  private async resolveForwardMediaUrl(
    source: { id: string; externalId: string | null },
    channel: Channel,
    content: Record<string, any>,
    organizationId: string,
    access: ChannelAccess,
  ): Promise<string> {
    const current = typeof content.mediaUrl === 'string' ? content.mediaUrl : '';
    if (current && !this.looksUnplayableMedia(current)) return current;

    if (!current) {
      const { url } = await this.mediaResolver.resolve(
        source.id,
        organizationId,
        access,
      );
      if (url && !this.looksUnplayableMedia(url)) return url;
    }

    // Cache vazio/`.enc` → resolve direto pelo provider.
    if (!source.externalId) {
      throw new BadRequestException(
        'Mídia ainda não sincronizada com o provider — tente de novo em alguns segundos.',
      );
    }
    const adapter = this.adapterRegistry.getOutbound(channel.type);
    if (!adapter.resolveInboundMediaUrl) {
      throw new BadRequestException(
        `Resolução de mídia não suportada para ${channel.type}.`,
      );
    }
    const { fileUrl } = await adapter.resolveInboundMediaUrl(channel, {
      externalMessageId: source.externalId,
      mediaId: typeof content.mediaId === 'string' ? content.mediaId : undefined,
      mimeType: typeof content.mimeType === 'string' ? content.mimeType : undefined,
      originalFilename:
        typeof content.fileName === 'string' ? content.fileName : undefined,
    });
    if (!fileUrl) {
      throw new BadRequestException(
        'Mídia da mensagem não pôde ser resolvida para encaminhar.',
      );
    }
    return fileUrl;
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

/** Mensagem legível de um erro qualquer, pro relatório de destinos do forward. */
function errorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'message' in res) {
      const m = (res as { message: unknown }).message;
      return Array.isArray(m) ? m.join(', ') : String(m);
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
