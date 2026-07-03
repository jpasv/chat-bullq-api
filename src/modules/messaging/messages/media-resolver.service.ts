import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { resolveAssignmentScope } from '../conversations/conversation-scope';

/**
 * Resolves a playable URL for an inbound media message.
 *
 * WhatsApp delivers media as encrypted .enc CDN URLs that browsers can't play.
 * The provider adapter knows how to decrypt and hand us a playable URL; we
 * cache it on `message.content.mediaUrl` so each message hits the provider
 * at most once. (If the cached URL eventually expires the client will get a
 * 404 on playback and we can re-resolve then — not worth the complexity yet.)
 */
@Injectable()
export class MediaResolverService {
  private readonly logger = new Logger(MediaResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
  ) {}

  async resolve(
    messageId: string,
    organizationId: string,
    access: import('../../iam/channel-access/channel-access.service').ChannelAccess = 'ALL',
    currentUserId?: string,
    role?: OrgRole,
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
    if (
      currentUserId &&
      resolveAssignmentScope(role, currentUserId) &&
      message.conversation.assignedToId !== currentUserId
    ) {
      throw new ForbiddenException();
    }

    const content = (message.content ?? {}) as Record<string, any>;

    if (typeof content.mediaUrl === 'string' && content.mediaUrl) {
      return { url: content.mediaUrl, mimeType: content.mimeType };
    }

    const channel = message.conversation.channel;
    const externalId = message.externalId;
    if (!externalId) {
      throw new BadRequestException('Message has no external id to resolve');
    }

    const adapter = this.adapterRegistry.getOutbound(channel.type);
    if (!adapter.resolveInboundMediaUrl) {
      throw new BadRequestException(
        `Media resolution not implemented for ${channel.type}`,
      );
    }

    const { fileUrl, mimeType } = await adapter.resolveInboundMediaUrl(
      channel,
      {
        externalMessageId: externalId,
        mediaId: typeof content.mediaId === 'string' ? content.mediaId : undefined,
        mimeType: typeof content.mimeType === 'string' ? content.mimeType : undefined,
        originalFilename: typeof content.fileName === 'string' ? content.fileName : undefined,
      },
    );

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        content: {
          ...content,
          mediaUrl: fileUrl,
          ...(mimeType && !content.mimeType ? { mimeType } : {}),
        } as any,
      },
    });

    return { url: fileUrl, mimeType: mimeType || content.mimeType };
  }
}
