import { Injectable } from '@nestjs/common';
import { Prisma, SocialComment, SocialCommentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type SocialCommentView = SocialComment & { replies: SocialComment[] };

export interface ListRootsParams {
  organizationId: string;
  /** Canais permitidos. `undefined` = todos da org. */
  channelIds?: string[];
  channelId?: string;
  status?: SocialCommentStatus;
  unreplied?: boolean;
  cursor?: string;
  limit: number;
}

@Injectable()
export class SocialCommentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.socialComment.findUnique({ where: { id } });
  }

  findByExternal(channelId: string, externalId: string) {
    return this.prisma.socialComment.findUnique({
      where: { uq_social_comment_external: { channelId, externalId } },
    });
  }

  /**
   * `created` vem do próprio write, não de um pre-read: com concorrência 10
   * no processor e redelivery at-least-once do Meta, dois workers podem ver
   * "not found" ao mesmo tempo antes de qualquer um escrever. Tentar o
   * `create` e cair pro `update` só em conflito de unique (P2002) garante
   * que só o worker que efetivamente inseriu a linha reporta `created: true`
   * — o outro perde a corrida no banco e recebe `created: false`.
   */
  async createOrUpdateFromWebhook(data: {
    organizationId: string;
    channelId: string;
    externalId: string;
    parentExternalId?: string;
    mediaId: string;
    authorExternalId: string;
    authorUsername?: string;
    text: string;
    isFromPage: boolean;
    commentedAt: Date;
  }): Promise<{ row: SocialComment; created: boolean }> {
    try {
      const row = await this.prisma.socialComment.create({
        data: {
          organizationId: data.organizationId,
          channelId: data.channelId,
          externalId: data.externalId,
          parentExternalId: data.parentExternalId ?? null,
          mediaId: data.mediaId,
          authorExternalId: data.authorExternalId,
          authorUsername: data.authorUsername ?? null,
          text: data.text,
          isFromPage: data.isFromPage,
          commentedAt: data.commentedAt,
        },
      });
      return { row, created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await this.prisma.socialComment.update({
          where: {
            uq_social_comment_external: {
              channelId: data.channelId,
              externalId: data.externalId,
            },
          },
          data: {
            text: data.text,
            authorUsername: data.authorUsername ?? undefined,
          },
        });
        return { row, created: false };
      }
      throw err;
    }
  }

  update(id: string, data: Prisma.SocialCommentUncheckedUpdateInput) {
    return this.prisma.socialComment.update({ where: { id }, data });
  }

  /** Marca o pai como respondido se ainda não estava. */
  async markParentReplied(
    channelId: string,
    parentExternalId: string,
    repliedById: string | null,
  ) {
    await this.prisma.socialComment.updateMany({
      where: { channelId, externalId: parentExternalId, repliedAt: null },
      data: { repliedAt: new Date(), repliedById },
    });
  }

  /** Copia dados da mídia de um irmão já enriquecido (mesmo post). */
  findEnrichedSibling(channelId: string, mediaId: string) {
    return this.prisma.socialComment.findFirst({
      where: { channelId, mediaId, mediaPermalink: { not: null } },
      select: { mediaPermalink: true, mediaCaption: true, mediaThumbnailUrl: true },
    });
  }

  async applyMediaToAll(
    channelId: string,
    mediaId: string,
    media: { mediaPermalink?: string | null; mediaCaption?: string | null; mediaThumbnailUrl?: string | null },
  ) {
    await this.prisma.socialComment.updateMany({
      where: { channelId, mediaId, mediaPermalink: null },
      data: media,
    });
  }

  async findThread(channelId: string, rootExternalId: string): Promise<SocialCommentView | null> {
    const root = await this.findByExternal(channelId, rootExternalId);
    if (!root) return null;
    const replies = await this.prisma.socialComment.findMany({
      where: { channelId, parentExternalId: rootExternalId },
      orderBy: { commentedAt: 'asc' },
    });
    return { ...root, replies };
  }

  async listRoots(params: ListRootsParams): Promise<{ items: SocialCommentView[]; nextCursor: string | null }> {
    const where: Prisma.SocialCommentWhereInput = {
      organizationId: params.organizationId,
      parentExternalId: null,
    };
    if (params.channelIds) where.channelId = { in: params.channelIds };
    if (params.channelId) where.channelId = params.channelId;
    if (params.status) where.status = params.status;
    if (params.unreplied) {
      where.repliedAt = null;
      where.status = SocialCommentStatus.VISIBLE;
    }

    const roots = await this.prisma.socialComment.findMany({
      where,
      orderBy: [{ commentedAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = roots.length > params.limit;
    const page = hasMore ? roots.slice(0, params.limit) : roots;
    if (page.length === 0) return { items: [], nextCursor: null };

    const replies = await this.prisma.socialComment.findMany({
      where: {
        channelId: { in: [...new Set(page.map((r) => r.channelId))] },
        parentExternalId: { in: page.map((r) => r.externalId) },
      },
      orderBy: { commentedAt: 'asc' },
    });
    const byParent = new Map<string, SocialComment[]>();
    for (const r of replies) {
      const key = `${r.channelId}:${r.parentExternalId}`;
      byParent.set(key, [...(byParent.get(key) ?? []), r]);
    }

    return {
      items: page.map((root) => ({
        ...root,
        replies: byParent.get(`${root.channelId}:${root.externalId}`) ?? [],
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
