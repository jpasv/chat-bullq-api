import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import {
  OutboundChannelPort,
  ResolveMediaHint,
} from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { ZappfyMessageMapper } from './zappfy.message-mapper';
import { ZappfyHttpClient } from './zappfy.http-client';
import { UploadsService } from '../../../messaging/messages/uploads.service';

@Injectable()
export class ZappfyOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_ZAPPFY;
  private readonly logger = new Logger(ZappfyOutboundAdapter.name);

  constructor(
    private readonly mapper: ZappfyMessageMapper,
    private readonly httpClient: ZappfyHttpClient,
    private readonly uploads: UploadsService,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const { endpoint, payload } = this.mapper.denormalize(
      message,
      contactExternalId,
    );

    const response = await this.httpClient.sendRequest(
      channel,
      endpoint,
      payload,
    );

    return {
      // Prefer `messageid` — the send response returns `id` as `<owner>:<msgid>`
      // but webhook echoes only carry the bare `<msgid>` in `messageid`. Using
      // the same shape on both sides keeps the unique (conversationId,externalId)
      // matching so the echo merges into our placeholder instead of duplicating.
      externalId:
        response?.messageid ||
        response?.key?.id ||
        response?.id ||
        '',
      providerResponse: response,
    };
  }

  async sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void> {
    const number = contactExternalId.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    try {
      await this.httpClient.sendRequest(channel, '/message/presence', {
        number,
        presence: 'composing',
      });
    } catch (error: any) {
      this.logger.warn(`Typing indicator failed: ${error.message}`);
    }
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    return this.httpClient.getMediaBuffer(channel, mediaId);
  }

  /**
   * Pede a mídia decifrada à Uazapi e guarda uma cópia no nosso disco. O
   * link que a Uazapi devolve expira em ~2 dias (ver isUazapiFileUrl) — sem
   * a cópia, áudio/imagem/documento com mais de 2 dias não abria mais.
   * Mesmo esquema do adapter do WhatsApp oficial.
   *
   * Se a cópia falhar (arquivo acima do limite, disco), devolve o link da
   * Uazapi mesmo: funciona por ~2 dias e o MediaResolverService tenta
   * re-hospedar de novo na próxima vez que alguém abrir a mídia.
   */
  async resolveInboundMediaUrl(
    channel: Channel,
    hint: ResolveMediaHint,
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    const resolved = await this.httpClient.resolveInboundMediaUrl(
      channel,
      hint.externalMessageId,
    );
    try {
      const buffer = await this.httpClient.getMediaBuffer(channel, resolved.fileUrl);
      const saved = await this.uploads.saveInboundMedia({
        buffer,
        mimeType: resolved.mimeType || hint.mimeType || 'application/octet-stream',
        channelId: channel.id,
        originalFilename: hint.originalFilename ?? null,
      });
      return { fileUrl: saved.url, mimeType: saved.mimeType };
    } catch (error: any) {
      this.logger.warn(
        `Re-host da mídia ${hint.externalMessageId} falhou, usando link temporário da Uazapi: ${error?.message}`,
      );
      return resolved;
    }
  }

  async deleteMessage(
    channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    await this.httpClient.deleteMessage(channel, externalMessageId);
  }

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 1,
      maxPerMinute: 30,
      windowMs: 60000,
    };
  }
}
