import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import axios from 'axios';
import {
  ClosedConversationInfo,
  OutboundChannelPort,
} from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  RateLimitConfig,
  SendResult,
} from '../../ports/types';
import { signMembersBody } from './members.signature';
import {
  BULLQ_SIGNATURE_HEADER,
  MembersCallbackPayload,
  MembersChannelConfig,
} from './members.types';

const CALLBACK_TIMEOUT_MS = 10_000;

/**
 * Entrega respostas (e o fechamento da conversa) pro members-backend via
 * callback HTTP assinado. Erro de rede / não-2xx propaga: o job do BullMQ
 * falha e entra no retry/backoff padrão (a mensagem termina FAILED como nos
 * outros canais).
 */
@Injectable()
export class MembersOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.MEMBERS;
  private readonly logger = new Logger(MembersOutboundAdapter.name);

  async sendMessage(
    channel: Channel,
    _contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const ctx = message.membersContext;
    if (!ctx?.conversationExternalId) {
      throw new Error(
        'MEMBERS outbound sem conversationExternalId (Conversation.externalThreadId ausente)',
      );
    }
    const content = (message.content ?? {}) as Record<string, any>;
    const text =
      typeof content.text === 'string' && content.text.length > 0
        ? content.text
        : typeof content.caption === 'string'
          ? content.caption
          : '';
    if (!text) {
      throw new Error('Canal Área de membros só suporta mensagens de texto');
    }

    const payload: MembersCallbackPayload = {
      event: 'message',
      conversationId: ctx.conversationExternalId,
      message: {
        id: ctx.messageId,
        text,
        agentName: ctx.agentName ?? null,
        createdAt: ctx.createdAt,
      },
    };
    const providerResponse = await this.post(channel, payload);
    return { externalId: ctx.messageId, providerResponse };
  }

  async onConversationClosed(
    channel: Channel,
    conversation: ClosedConversationInfo,
  ): Promise<void> {
    if (!conversation.externalThreadId) {
      this.logger.warn(
        `conversation_closed skipped: conv ${conversation.id} has no externalThreadId`,
      );
      return;
    }
    await this.post(channel, {
      event: 'conversation_closed',
      conversationId: conversation.externalThreadId,
      closedAt: new Date(conversation.closedAt).toISOString(),
    });
  }

  /** Widget da área de membros não tem indicador de digitação. */
  async sendTypingIndicator(): Promise<void> {
    return;
  }

  async getMediaUrl(): Promise<string> {
    throw new Error('Canal Área de membros não suporta mídia');
  }

  async downloadMedia(): Promise<Buffer> {
    throw new Error('Canal Área de membros não suporta mídia');
  }

  getRateLimits(): RateLimitConfig {
    return { maxPerSecond: 20, maxPerMinute: 600, windowMs: 1000 };
  }

  private async post(
    channel: Channel,
    payload: MembersCallbackPayload,
  ): Promise<unknown> {
    const cfg = (channel.config ?? {}) as unknown as Partial<MembersChannelConfig>;
    if (!cfg.callbackUrl || !cfg.callbackSecret) {
      throw new Error(
        `Canal MEMBERS ${channel.id} sem callbackUrl/callbackSecret configurados`,
      );
    }
    const body = JSON.stringify(payload);
    const response = await axios.post(cfg.callbackUrl, body, {
      headers: {
        'Content-Type': 'application/json',
        [BULLQ_SIGNATURE_HEADER]: signMembersBody(body, cfg.callbackSecret),
      },
      timeout: CALLBACK_TIMEOUT_MS,
      // Só 2xx é sucesso — qualquer outro status falha o job (retry).
      validateStatus: (s) => s >= 200 && s < 300,
      // Corpo já serializado: assinatura tem que bater byte a byte.
      transformRequest: [(data) => data],
    });
    return response.data;
  }
}
