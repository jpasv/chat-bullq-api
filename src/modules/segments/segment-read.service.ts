import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

interface ConvWithJid {
  id: string;
  channelId: string;
  lastMessageAt: Date | null;
  jid: string | null;
}

/**
 * Unificação de grupos POR LEITURA. Os Segmentos não alteram/movem nada no
 * banco: cada número (canal) mantém suas próprias conversas de grupo. Este
 * serviço apenas consulta as conversas dos canais-membros e as agrupa pelo
 * JID do grupo (ex.: `1203...@g.us`) para apresentar a inbox unificada e a
 * timeline combinada das mensagens.
 */
@Injectable()
export class SegmentReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Canais-membros do segmento ativo a que este canal pertence, ou null. */
  async segmentMembersForChannel(
    channelId: string,
  ): Promise<{ segmentId: string; memberChannelIds: string[] } | null> {
    const membership = await this.prisma.segmentChannel.findFirst({
      where: { channelId, segment: { isActive: true, deletedAt: null } },
      select: {
        segmentId: true,
        segment: { select: { members: { select: { channelId: true } } } },
      },
    });
    if (!membership) return null;
    return {
      segmentId: membership.segmentId,
      memberChannelIds: membership.segment.members.map((m) => m.channelId),
    };
  }

  private async memberChannelIds(
    organizationId: string,
    segmentId: string,
  ): Promise<string[]> {
    const seg = await this.prisma.segment.findFirst({
      where: { id: segmentId, organizationId, isActive: true, deletedAt: null },
      select: { members: { select: { channelId: true } } },
    });
    return seg ? seg.members.map((m) => m.channelId) : [];
  }

  /** Conversas de grupo dos canais-membros, já com o JID do grupo derivado. */
  private async loadGroupConvs(
    organizationId: string,
    memberChannelIds: string[],
  ): Promise<ConvWithJid[]> {
    if (memberChannelIds.length === 0) return [];
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        channelId: { in: memberChannelIds },
        isGroup: true,
        deletedAt: null,
      },
      select: {
        id: true,
        channelId: true,
        lastMessageAt: true,
        contact: {
          select: { channels: { select: { channelId: true, externalId: true } } },
        },
      },
    });
    return convs.map((c) => ({
      id: c.id,
      channelId: c.channelId,
      lastMessageAt: c.lastMessageAt,
      jid:
        c.contact?.channels.find((ch) => ch.channelId === c.channelId)
          ?.externalId ?? null,
    }));
  }

  /**
   * Uma conversa "representante" por JID de grupo — a de atividade mais
   * recente. É a conversa que a inbox exibe (uma linha por grupo); a timeline
   * dela faz a união com as conversas-irmãs ao abrir.
   */
  async groupRepresentativeIds(
    organizationId: string,
    segmentId: string,
  ): Promise<string[]> {
    const members = await this.memberChannelIds(organizationId, segmentId);
    const convs = await this.loadGroupConvs(organizationId, members);
    const repByJid = new Map<string, ConvWithJid>();
    for (const c of convs) {
      if (!c.jid) continue;
      const cur = repByJid.get(c.jid);
      const t = c.lastMessageAt?.getTime() ?? 0;
      const curT = cur?.lastMessageAt?.getTime() ?? 0;
      if (!cur || t > curT) repByJid.set(c.jid, c);
    }
    return Array.from(repByJid.values()).map((c) => c.id);
  }

  /**
   * Ids das conversas-irmãs (mesmo JID de grupo nos canais-membros) — inclui
   * a própria. Retorna null quando a conversa não é um grupo de segmento ou
   * não tem irmãs (caminho normal de conversa única).
   */
  async groupSiblingIds(conversationId: string): Promise<string[] | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        organizationId: true,
        channelId: true,
        isGroup: true,
        contact: {
          select: { channels: { select: { channelId: true, externalId: true } } },
        },
      },
    });
    if (!conv || !conv.isGroup) return null;

    const seg = await this.segmentMembersForChannel(conv.channelId);
    if (!seg) return null;

    const jid =
      conv.contact?.channels.find((ch) => ch.channelId === conv.channelId)
        ?.externalId ?? null;
    if (!jid) return null;

    const siblings = await this.prisma.conversation.findMany({
      where: {
        organizationId: conv.organizationId,
        channelId: { in: seg.memberChannelIds },
        isGroup: true,
        deletedAt: null,
        contact: {
          channels: {
            some: { channelId: { in: seg.memberChannelIds }, externalId: jid },
          },
        },
      },
      select: { id: true },
    });
    const ids = siblings.map((s) => s.id);
    return ids.length > 1 ? ids : null;
  }
}
