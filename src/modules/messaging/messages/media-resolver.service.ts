import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  GoneException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import type { Channel } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { isUazapiFileUrl } from '../../channel-hub/adapters/zappfy/zappfy-media-url';
import { UploadsService } from './uploads.service';

/**
 * Resolves a playable URL for an inbound media message.
 *
 * WhatsApp delivers media as encrypted .enc CDN URLs that browsers can't play.
 * The provider adapter knows how to decrypt and hand us a playable URL; we
 * cache it on `message.content.mediaUrl` so each message hits the provider
 * at most once.
 *
 * O cache só vale se a URL for permanente. Duas exceções são re-resolvidas:
 *  - link temporário da Uazapi (`*.uazapi.com/files/...`, morre em ~2 dias):
 *    enquanto vivo, copiamos direto dele pro nosso disco; morto, pedimos de
 *    novo ao provider (que já devolve cópia local);
 *  - upload nosso cujo arquivo sumiu do disco.
 * Quando o provider também não tem mais a mídia, responde 410 em vez de 500.
 */
@Injectable()
export class MediaResolverService {
  private readonly logger = new Logger(MediaResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly uploads: UploadsService,
  ) {}

  async resolve(
    messageId: string,
    organizationId: string,
    access: import('../../iam/channel-access/channel-access.service').ChannelAccess = 'ALL',
  ): Promise<{ url: string; mimeType?: string }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { channel: true } } },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new NotFoundException('Message not found');
    }
    if (
      access !== 'ALL' &&
      !access.has(message.conversation.channelId)
    ) {
      throw new NotFoundException('Message not found');
    }

    const content = (message.content ?? {}) as Record<string, any>;
    const channel = message.conversation.channel;
    const cachedUrl =
      typeof content.mediaUrl === 'string' && content.mediaUrl ? content.mediaUrl : null;

    if (cachedUrl && this.isPermanent(cachedUrl)) {
      return { url: cachedUrl, mimeType: content.mimeType };
    }

    if (cachedUrl && isUazapiFileUrl(cachedUrl)) {
      const rehosted = await this.rehostFromUrl(cachedUrl, channel, content);
      if (rehosted) {
        await this.persist(messageId, content, rehosted);
        return { url: rehosted.url, mimeType: rehosted.mimeType || content.mimeType };
      }
    }

    const externalId = message.externalId;
    if (!externalId) {
      if (cachedUrl) throw this.expiredError();
      throw new BadRequestException('Message has no external id to resolve');
    }

    const adapter = this.adapterRegistry.getOutbound(channel.type);
    if (!adapter.resolveInboundMediaUrl) {
      if (cachedUrl) return { url: cachedUrl, mimeType: content.mimeType };
      throw new BadRequestException(
        `Media resolution not implemented for ${channel.type}`,
      );
    }

    let resolved: { fileUrl: string; mimeType?: string };
    try {
      resolved = await adapter.resolveInboundMediaUrl(channel, {
        externalMessageId: externalId,
        mediaId: typeof content.mediaId === 'string' ? content.mediaId : undefined,
        mimeType: typeof content.mimeType === 'string' ? content.mimeType : undefined,
        originalFilename: typeof content.fileName === 'string' ? content.fileName : undefined,
      });
    } catch (error: any) {
      // Erro já traduzido pelo adapter (ex.: WhatsApp oficial sem mediaId).
      if (error instanceof HttpException) throw error;
      const status = error?.response?.status;
      this.logger.warn(
        `Media resolve failed msg=${messageId} channel=${channel.type} status=${status ?? '-'}: ${error?.message}`,
      );
      // 404 do provider = a mídia não existe mais lá (Uazapi esquece em ~1
      // semana). Outros erros (instância desconectada, timeout) são
      // transitórios — o cliente pode tentar de novo depois.
      if (status === 404) throw this.expiredError();
      throw new ServiceUnavailableException(
        'Não foi possível buscar a mídia no provedor agora. Tente de novo em instantes.',
      );
    }

    await this.persist(messageId, content, {
      url: resolved.fileUrl,
      mimeType: resolved.mimeType,
    });
    return { url: resolved.fileUrl, mimeType: resolved.mimeType || content.mimeType };
  }

  /** URL que pode ser servida como está, sem voltar ao provider. */
  private isPermanent(url: string): boolean {
    return !isUazapiFileUrl(url) && !this.uploads.isMissingLocalUpload(url);
  }

  /**
   * Copia a mídia de um link ainda vivo pro nosso disco. Devolve null se o
   * link já morreu ou a cópia falhou — o chamador cai no provider.
   */
  private async rehostFromUrl(
    url: string,
    channel: Channel,
    content: Record<string, any>,
  ): Promise<{ url: string; mimeType?: string } | null> {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: UploadsService.MAX_INBOUND_BYTES,
      });
      const headerMime =
        typeof response.headers?.['content-type'] === 'string'
          ? response.headers['content-type']
          : undefined;
      const saved = await this.uploads.saveInboundMedia({
        buffer: Buffer.from(response.data),
        mimeType:
          (typeof content.mimeType === 'string' && content.mimeType) ||
          headerMime ||
          'application/octet-stream',
        channelId: channel.id,
        originalFilename: typeof content.fileName === 'string' ? content.fileName : null,
      });
      return { url: saved.url, mimeType: saved.mimeType };
    } catch (error: any) {
      this.logger.debug?.(
        `Re-host from cached URL failed (${error?.response?.status ?? error?.message}) — falling back to provider`,
      );
      return null;
    }
  }

  private async persist(
    messageId: string,
    content: Record<string, any>,
    media: { url: string; mimeType?: string },
  ): Promise<void> {
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        content: {
          ...content,
          mediaUrl: media.url,
          ...(media.mimeType && !content.mimeType ? { mimeType: media.mimeType } : {}),
        } as any,
      },
    });
  }

  private expiredError(): GoneException {
    return new GoneException(
      'Essa mídia não está mais disponível no WhatsApp (expirou antes de ser salva).',
    );
  }
}
