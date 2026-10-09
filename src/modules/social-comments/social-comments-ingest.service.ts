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

    const { row: saved, created } = await this.repo.createOrUpdateFromWebhook({
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

    if (created && isFromPage && comment.parentExternalId) {
      await this.repo.markParentReplied(channelId, comment.parentExternalId, null);
    }

    await this.enrichMedia(channel, comment.mediaId);
    if (created && !isFromPage) {
      await this.enrichAuthorAvatar(channel, comment.authorExternalId);
    }

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

  /**
   * Foto do autor, best-effort: contato do inbox ou outro comentário dele
   * (grátis), senão `getUserProfile` na Graph — que só devolve `profile_pic`
   * de quem já conversou com a conta. Sem foto, o front mostra a inicial.
   */
  private async enrichAuthorAvatar(channel: { id: string } & Record<string, any>, authorExternalId: string) {
    try {
      const known = await this.repo.findKnownAuthorAvatar(channel.id, authorExternalId);
      if (known) {
        await this.repo.applyAuthorAvatar(channel.id, authorExternalId, known);
        return;
      }
      const profile = await this.instagram.getUserProfile(channel as any, authorExternalId);
      if (profile?.profile_pic) {
        await this.repo.applyAuthorAvatar(channel.id, authorExternalId, profile.profile_pic);
      }
    } catch (err: any) {
      this.logger.warn(`author avatar(${authorExternalId}) failed: ${err?.message ?? err}`);
    }
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
