import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MessageStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NormalizedOutboundMessage } from '../../channel-hub/ports/types';
import { IdempotencyService } from './idempotency.service';

interface OutboundJobData {
  messageId: string;
  channelId: string;
  contactExternalId: string;
  message: NormalizedOutboundMessage;
}

@Processor('outbound-messages', { concurrency: 5 })
export class OutboundMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundMessageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  async process(job: Job<OutboundJobData>): Promise<any> {
    const { messageId, channelId, contactExternalId, message } = job.data;

    const channel = await this.prisma.channel.findUniqueOrThrow({
      where: { id: channelId },
    });

    const adapter = this.adapterRegistry.getOutbound(channel.type);

    // Humanize: if this message was sent by an AI agent, simulate typing
    // delay proportional to text length before actually sending. Customers
    // perceive instant replies as bot-like; a 2-4s "typing..." gap with the
    // typing indicator on feels like a real person on the other side.
    await this.simulateTypingIfAiMessage({
      messageId,
      channel,
      contactExternalId,
      message,
      adapter,
    });

    try {
      const result = await adapter.sendMessage(
        channel,
        contactExternalId,
        message,
      );

      // Persist externalId FIRST, then mark idempotency so that a subsequent
      // echo webhook for the same externalId is recognised as a duplicate
      // instead of creating a phantom row.
      let updated;
      try {
        updated = await this.prisma.message.update({
          where: { id: messageId },
          data: {
            status: MessageStatus.SENT,
            externalId: result.externalId || null,
            sentAt: new Date(),
            metadata: {
              providerResponse: safeJson(result.providerResponse),
            },
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002' && result.externalId) {
          // A webhook echo raced us and already inserted a row with this
          // externalId. Merge: delete our QUEUED placeholder and reuse the
          // echo row so there is a single source-of-truth.
          this.logger.warn(
            `Outbound echo race on ${result.externalId} — merging into existing row`,
          );
          const placeholder = await this.prisma.message.findUnique({
            where: { id: messageId },
          });
          const echoRow = await this.prisma.message.findFirst({
            where: {
              externalId: result.externalId,
              id: { not: messageId },
            },
          });
          if (echoRow && placeholder) {
            // Copy senderId + content from placeholder to echo row. Echo has
            // no sender, and for media messages the echo's content lacks the
            // playable mediaUrl (WhatsApp echoes an encrypted .enc CDN URL
            // that browsers cannot decrypt). Our placeholder already has the
            // locally-hosted URL we uploaded — that is the authoritative one.
            const patch: Record<string, any> = {};
            if (placeholder.senderId && !echoRow.senderId) {
              patch.senderId = placeholder.senderId;
            }
            const placeholderContent = placeholder.content as any;
            if (placeholderContent?.mediaUrl) {
              patch.content = placeholderContent;
            }
            if (Object.keys(patch).length > 0) {
              await this.prisma.message.update({
                where: { id: echoRow.id },
                data: patch,
              });
            }
            await this.prisma.message
              .delete({ where: { id: messageId } })
              .catch(() => undefined);
            updated = await this.prisma.message.findUniqueOrThrow({
              where: { id: echoRow.id },
            });
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      if (result.externalId) {
        await this.idempotency.markProcessed(result.externalId, channelId);
      }

      this.emitStatusUpdate(updated.conversationId, updated.id, MessageStatus.SENT);
      this.realtimeGateway.emitToChannel(channel.id, 'message:new', {
        message: updated,
        conversationId: updated.conversationId,
      });
      // Também pra room da conversa: quem está com o chat aberto entra em
      // conv:<id>, não necessariamente em channel:<id>. No echo de mídia o
      // id da mensagem pode ter trocado (placeholder deletado), então o
      // message:status sozinho não basta — o front precisa do objeto inteiro.
      this.realtimeGateway.emitToConversation(updated.conversationId, 'message:new', {
        message: updated,
        conversationId: updated.conversationId,
      });
      this.logger.log(
        `Outbound sent: msg=${updated.id} externalId=${result.externalId}`,
      );

      return { success: true, externalId: result.externalId };
    } catch (error: any) {
      this.logger.error(
        `Outbound failed: msg=${messageId} - ${error.message}`,
      );
      const updated = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          status: MessageStatus.FAILED,
          failedReason: error.message?.slice?.(0, 500) ?? String(error),
        },
      });

      this.emitStatusUpdate(
        updated.conversationId,
        messageId,
        MessageStatus.FAILED,
      );
      throw error;
    }
  }

  private emitStatusUpdate(
    conversationId: string,
    messageId: string,
    status: MessageStatus,
  ) {
    const payload = { messageId, status, conversationId };
    this.realtimeGateway.emitToConversation(
      conversationId,
      'message:status',
      payload,
    );
  }

  /**
   * Pre-send humanization for AI replies: turn on the typing indicator on
   * the customer's chat and wait for a delay proportional to how long a
   * human would actually take to type the message.
   *
   * Only runs for messages flagged as coming from an AI agent — handled by
   * checking message.metadata.aiAgentId. Manual operator replies and
   * webhook echoes are sent immediately, no fake typing.
   *
   * Delay model: 900ms base + 28ms/char, clamped to [1000, 6000]ms.
   * For a 12-char "opa, beleza!" → ~1.2s. For a 100-char message → ~3.7s.
   * Caps at 6s so the customer never feels the bot froze.
   */
  private async simulateTypingIfAiMessage(args: {
    messageId: string;
    channel: { id: string; type: any };
    contactExternalId: string;
    message: NormalizedOutboundMessage;
    adapter: any;
  }): Promise<void> {
    try {
      const row = await this.prisma.message.findUnique({
        where: { id: args.messageId },
        select: { metadata: true, conversationId: true },
      });
      const aiAgentId = (row?.metadata as any)?.aiAgentId;
      if (!aiAgentId) return; // not an AI message, send immediately

      const text = (args.message?.content as any)?.text ?? '';
      if (typeof text !== 'string' || text.length === 0) return;

      const delayMs = Math.min(
        6000,
        Math.max(1000, 900 + text.length * 28),
      );

      // Fire typing indicator on the underlying channel (WhatsApp/IG).
      // Don't await — start typing AND start counting delay in parallel.
      args.adapter
        .sendTypingIndicator(args.channel, args.contactExternalId)
        .catch((err: any) =>
          this.logger.warn(`Typing indicator failed: ${err?.message ?? err}`),
        );

      // Notify the in-app UI (Hoppe) that the agent is "typing".
      if (row?.conversationId) {
        this.realtimeGateway.emitToConversation(
          row.conversationId,
          'agent:typing',
          { conversationId: row.conversationId, agentId: aiAgentId },
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch (err: any) {
      // Never let humanization break sending.
      this.logger.warn(`simulateTyping failed: ${err?.message ?? err}`);
    }
  }
}

function safeJson(value: unknown): any {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}
