import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { InstagramHttpClient } from '../channel-hub/adapters/instagram/instagram.http-client';
import { NormalizedComment } from '../channel-hub/ports/types';
import { SocialCommentsRepository } from './social-comments.repository';

export interface CommentJobData {
  channelId: string;
  organizationId: string;
  webhookEventId?: string;
  comment: NormalizedComment;
}

@Injectable()
export class SocialCommentsIngestService {
  private readonly logger = new Logger(SocialCommentsIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SocialCommentsRepository,
    private readonly instagram: InstagramHttpClient,
    private readonly realtime: RealtimeGateway,
  ) {}

  async ingest(data: CommentJobData): Promise<{ created: boolean }> {
    const { channelId, organizationId, comment } = data;
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      this.logger.warn(`Comment ${comment.externalId}: channel ${channelId} not found`);
      return { created: false };
    }

    const cfg = (channel.config ?? {}) as Record<string, any>;
    const igBusinessId = String(cfg.igBusinessId ?? cfg.igUserId ?? '');
    const isFromPage = !!igBusinessId && comment.authorExternalId === igBusinessId;

    const existed = await this.repo.findByExternal(channelId, comment.externalId);
    const saved = await this.repo.upsertFromWebhook({
      organizationId,
      channelId,
      externalId: comment.externalId,
      parentExternalId: comment.parentExternalId,
      mediaId: comment.mediaId,
      authorExternalId: comment.authorExternalId,
      authorUsername: comment.authorUsername,
      text: comment.text,
      isFromPage,
      commentedAt: comment.commentedAt,
    });
    const created = !existed;

    if (created && isFromPage && comment.parentExternalId) {
      await this.repo.markParentReplied(channelId, comment.parentExternalId, null);
    }

    await this.enrichMedia(channel, comment.mediaId);

    if (!created) return { created: false };

    const rootExternalId = comment.parentExternalId ?? comment.externalId;
    const thread = await this.repo.findThread(channelId, rootExternalId);
    if (thread) {
      const event = comment.parentExternalId ? 'comment:updated' : 'comment:new';
      this.realtime.emitToChannel(channelId, event, thread);
    }
    this.logger.log(`Comment ${saved.externalId} ingested (channel ${channelId}, fromPage=${isFromPage})`);
    return { created: true };
  }

  private async enrichMedia(channel: { id: string } & Record<string, any>, mediaId: string) {
    const sibling = await this.repo.findEnrichedSibling(channel.id, mediaId);
    if (sibling) {
      await this.repo.applyMediaToAll(channel.id, mediaId, sibling);
      return;
    }
    try {
      const media = await this.instagram.getMedia(channel as any, mediaId);
      await this.repo.applyMediaToAll(channel.id, mediaId, {
        mediaPermalink: media.permalink ?? null,
        mediaCaption: media.caption ?? null,
        mediaThumbnailUrl: media.thumbnail_url ?? media.media_url ?? null,
      });
    } catch (err: any) {
      this.logger.warn(`getMedia(${mediaId}) failed: ${err?.message ?? err}`);
    }
  }
}
