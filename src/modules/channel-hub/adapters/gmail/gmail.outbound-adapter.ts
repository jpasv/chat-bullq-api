import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import axios from 'axios';
import {
  OutboundChannelPort,
  ResolveMediaHint,
} from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  RateLimitConfig,
  SendResult,
} from '../../ports/types';
import { UploadsService } from '../../../messaging/messages/uploads.service';
import { GmailHttpClient } from './gmail.http-client';
import {
  GmailMessageMapper,
  OutboundAttachment,
  collectAttachments,
} from './gmail.message-mapper';
import { GmailChannelConfig } from './gmail.constants';

@Injectable()
export class GmailOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.GMAIL;
  private readonly logger = new Logger(GmailOutboundAdapter.name);

  constructor(
    private readonly mapper: GmailMessageMapper,
    private readonly httpClient: GmailHttpClient,
    private readonly uploads: UploadsService,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const attachments = await this.buildAttachments(message);
    const { raw, threadId } = this.mapper.denormalizeOutbound(
      message,
      contactExternalId,
      channel,
      attachments,
    );

    const cfg = channel.config as unknown as GmailChannelConfig;

    // Modo rascunho: a "resposta" vira draft na caixa pra revisão humana —
    // ninguém recebe nada até alguém apertar enviar no Gmail.
    if (cfg?.sendMode === 'draft') {
      const draft = await this.httpClient.createDraft(channel, raw, threadId);
      return {
        externalId: draft.message?.id || draft.id || '',
        providerResponse: draft,
      };
    }

    const response = await this.httpClient.sendMessage(channel, raw, threadId);
    return {
      externalId: response.id || '',
      providerResponse: response,
    };
  }

  /** Email não tem indicador de digitação — no-op. */
  async sendTypingIndicator(): Promise<void> {
    return;
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  /**
   * `mediaId` composto `<gmailMessageId>#att<idx>` (mesmo shape do
   * externalId das mensagens de anexo) OU o gmailMessageId puro.
   */
  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    const { parentId, attIndex } = splitAttachmentId(mediaId);
    const attachmentId = await this.freshAttachmentId(
      channel,
      parentId,
      attIndex,
    );
    return this.httpClient.getAttachment(channel, parentId, attachmentId);
  }

  /**
   * Baixa o anexo e re-hospeda localmente (padrão Meta Cloud): a Gmail API
   * exige Bearer token pra baixar, então o browser não consegue carregar
   * direto. AttachmentIds do Gmail não são estáveis a longo prazo — sempre
   * re-buscamos o id fresco a partir da mensagem-pai.
   */
  async resolveInboundMediaUrl(
    channel: Channel,
    hint: ResolveMediaHint,
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    const { parentId, attIndex } = splitAttachmentId(hint.externalMessageId);
    const attachmentId = await this.freshAttachmentId(
      channel,
      parentId,
      attIndex,
    );
    const buffer = await this.httpClient.getAttachment(
      channel,
      parentId,
      attachmentId,
    );
    const saved = await this.uploads.saveInboundMedia({
      buffer,
      mimeType: hint.mimeType || 'application/octet-stream',
      channelId: channel.id,
      originalFilename: hint.originalFilename ?? null,
    });
    return { fileUrl: saved.url, mimeType: saved.mimeType };
  }

  /**
   * "Deletar" no email = mover pra LIXEIRA na caixa do canal. O destinatário
   * continua com a cópia dele (email não tem revoke) — paridade com o
   * comportamento do Instagram/Meta, que também não alcança o outro lado.
   */
  async deleteMessage(
    channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    await this.httpClient.trashMessage(
      channel,
      splitAttachmentId(externalMessageId).parentId,
    );
  }

  /**
   * Operador leu a conversa no inbox → remove UNREAD na caixa Gmail.
   * Idempotente (remover label ausente é no-op) e best-effort por
   * mensagem — uma falha não trava as demais.
   */
  async markConversationRead(
    channel: Channel,
    externalMessageIds: string[],
  ): Promise<void> {
    const parentIds = new Set(
      externalMessageIds.map((id) => splitAttachmentId(id).parentId),
    );
    for (const id of parentIds) {
      await this.httpClient
        .modifyLabels(channel, id, { remove: ['UNREAD'] })
        .catch((err: any) =>
          this.logger.warn(
            `Gmail read-sync falhou pra msg ${id}: ${err?.message ?? err}`,
          ),
        );
    }
  }

  getRateLimits(): RateLimitConfig {
    // messages.send custa 100 quota units; per-user 250 units/s → ~2/s.
    return {
      maxPerSecond: 2,
      maxPerMinute: 60,
      windowMs: 60000,
    };
  }

  /** Re-busca a mensagem-pai e devolve o attachmentId FRESCO do índice. */
  private async freshAttachmentId(
    channel: Channel,
    parentId: string,
    attIndex: number,
  ): Promise<string> {
    const parent = await this.httpClient.getMessage(channel, parentId, 'full');
    const attachments = collectAttachments(parent.payload);
    const att = attachments[attIndex];
    if (!att) {
      throw new Error(
        `Anexo #${attIndex} não encontrado na mensagem Gmail ${parentId}`,
      );
    }
    return att.attachmentId;
  }

  /** Anexo outbound: baixa os bytes do mediaUrl (MinIO/local) → MIME part. */
  private async buildAttachments(
    message: NormalizedOutboundMessage,
  ): Promise<OutboundAttachment[]> {
    const { mediaUrl, mimeType, fileName } = message.content ?? {};
    if (!mediaUrl) return [];
    try {
      const resp = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: 60_000,
      });
      return [
        {
          filename: fileName || `anexo.${extFromMime(mimeType)}`,
          mimeType: mimeType || 'application/octet-stream',
          buffer: Buffer.from(resp.data),
        },
      ];
    } catch (err: any) {
      this.logger.error(
        `Falha baixando mídia outbound ${mediaUrl}: ${err?.message ?? err}`,
      );
      throw err;
    }
  }
}

function splitAttachmentId(id: string): { parentId: string; attIndex: number } {
  const match = id.match(/^(.+)#att(\d+)$/);
  if (match) return { parentId: match[1], attIndex: Number(match[2]) };
  return { parentId: id, attIndex: 0 };
}

function extFromMime(mimeType?: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
  };
  return map[mimeType ?? ''] ?? 'bin';
}
