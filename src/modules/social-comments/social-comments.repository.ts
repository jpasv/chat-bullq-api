import { Injectable } from '@nestjs/common';
import { Prisma, SocialComment, SocialCommentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type SocialCommentView = SocialComment & { replies: SocialComment[] };

/** Cursor opaco pro cliente: `${commentedAt.getTime()}_${id}`. */
function parseCursor(cursor?: string): { commentedAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const idx = cursor.indexOf('_');
  if (idx <= 0) return undefined;
  const ms = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(ms) || !id) return undefined;
  return { commentedAt: new Date(ms), id };
}

export interface ListRootsParams {
  organizationId: string;
  /** Canais permitidos. `undefined` = todos da org. */
  channelIds?: string[];
  channelId?: string;
  mediaId?: string;
  status?: SocialCommentStatus;
  unreplied?: boolean;
  cursor?: string;
  limit: number;
}

export interface ListMediaParams {
  organizationId: string;
  /** Canais permitidos. `undefined` = todos da org. */
  channelIds?: string[];
  channelId?: string;
  limit: number;
}

/** Um post (mídia do Instagram) com o resumo dos comentários raiz dele. */
export interface SocialMediaSummary {
  channelId: string;
  mediaId: string;
  mediaPermalink: string | null;
  mediaCaption: string | null;
  mediaThumbnailUrl: string | null;
  /** Comentários raiz não deletados. */
  total: number;
  /** Raízes visíveis, de terceiros, sem resposta da página. */
  unreplied: number;
  lastCommentAt: Date;
}

/** Restrição de canal: interseção entre canais acessíveis e canal pedido. */
function channelWhere(
  channelIds?: string[],
  channelId?: string,
): Prisma.SocialCommentWhereInput['channelId'] | undefined {
  if (channelId) {
    if (channelIds && !channelIds.includes(channelId)) return { in: [] };
    return channelId;
  }
  return channelIds ? { in: channelIds } : undefined;
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
    const channel = channelWhere(params.channelIds, params.channelId);
    if (channel !== undefined) where.channelId = channel;
    if (params.mediaId) where.mediaId = params.mediaId;
    if (params.status) where.status = params.status;
    if (params.unreplied) {
      where.repliedAt = null;
      where.status = SocialCommentStatus.VISIBLE;
      where.isFromPage = false;
    }

    const c = parseCursor(params.cursor);
    if (c) {
      where.OR = [
        { commentedAt: { lt: c.commentedAt } },
        { commentedAt: c.commentedAt, id: { lt: c.id } },
      ];
    }

    const roots = await this.prisma.socialComment.findMany({
      where,
      orderBy: [{ commentedAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
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
      nextCursor: hasMore
        ? `${page[page.length - 1].commentedAt.getTime()}_${page[page.length - 1].id}`
        : null,
    };
  }

  /**
   * Posts com comentários, do mais recente pro mais antigo (pelo último
   * comentário). Três consultas: totais por post, sem-resposta por post e
   * uma linha por post pra permalink/legenda/thumb (o enriquecimento grava
   * os mesmos dados em todas as linhas do post, então qualquer uma serve).
   */
  async listMedia(params: ListMediaParams): Promise<SocialMediaSummary[]> {
    const where: Prisma.SocialCommentWhereInput = {
      organizationId: params.organizationId,
      parentExternalId: null,
      status: { not: SocialCommentStatus.DELETED },
    };
    const channel = channelWhere(params.channelIds, params.channelId);
    if (channel !== undefined) where.channelId = channel;

    const totals = await this.prisma.socialComment.groupBy({
      by: ['channelId', 'mediaId'],
      where,
      _count: { _all: true },
      _max: { commentedAt: true },
      orderBy: { _max: { commentedAt: 'desc' } },
      take: params.limit,
    });
    if (totals.length === 0) return [];

    const pairs = totals.map((t) => ({ channelId: t.channelId, mediaId: t.mediaId }));
    const [unreplied, mediaRows] = await Promise.all([
      this.prisma.socialComment.groupBy({
        by: ['channelId', 'mediaId'],
        where: {
          ...where,
          OR: pairs,
          repliedAt: null,
          status: SocialCommentStatus.VISIBLE,
          isFromPage: false,
        },
        _count: { _all: true },
      }),
      this.prisma.socialComment.findMany({
        where: { OR: pairs },
        distinct: ['channelId', 'mediaId'],
        select: {
          channelId: true,
          mediaId: true,
          mediaPermalink: true,
          mediaCaption: true,
          mediaThumbnailUrl: true,
        },
      }),
    ]);

    const key = (r: { channelId: string; mediaId: string }) => `${r.channelId}:${r.mediaId}`;
    const unrepliedByKey = new Map(unreplied.map((u) => [key(u), u._count._all]));
    const mediaByKey = new Map(mediaRows.map((m) => [key(m), m]));

    return totals.map((t) => {
      const media = mediaByKey.get(key(t));
      return {
        channelId: t.channelId,
        mediaId: t.mediaId,
        mediaPermalink: media?.mediaPermalink ?? null,
        mediaCaption: media?.mediaCaption ?? null,
        mediaThumbnailUrl: media?.mediaThumbnailUrl ?? null,
        total: t._count._all,
        unreplied: unrepliedByKey.get(key(t)) ?? 0,
        lastCommentAt: t._max.commentedAt ?? new Date(0),
      };
    });
  }
}
