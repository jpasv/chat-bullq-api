import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

export type ChannelAccess = 'ALL' | Set<string>;

@Injectable()
export class ChannelAccessService {
  constructor(private readonly prisma: PrismaService) {}

  isBypassRole(role: OrgRole): boolean {
    return role === OrgRole.OWNER || role === OrgRole.ADMIN;
  }

  /**
   * Materializes which channels a user can see in the current org.
   *
   * Visibility rules:
   * - Channel.visibility = 'ORG'   → any member with normal channel rights
   *                                   (OWNER/ADMIN bypass, AGENT needs grant).
   * - Channel.visibility = 'PRIVATE' → ONLY explicit grants in ChannelAgent
   *                                    count, even for OWNER/ADMIN.
   *
   * Returns 'ALL' as an optimization when the user effectively sees every
   * non-deleted channel in the org (legacy behavior — kept so existing
   * Set-vs-ALL branches in callers don't need to materialize a Set on
   * every request when no private channels exist).
   */
  async getAccessibleChannelIds(
    userOrganizationId: string,
    role: OrgRole,
    organizationId?: string,
  ): Promise<ChannelAccess> {
    // AGENT: identical to before — only explicit grants.
    if (!this.isBypassRole(role)) {
      const rows = await this.prisma.channelAgent.findMany({
        where: { userOrganizationId },
        select: { channelId: true },
      });
      return new Set(rows.map((r) => r.channelId));
    }

    // OWNER/ADMIN path. We need the orgId to scope the query.
    let orgId = organizationId;
    if (!orgId) {
      const userOrg = await this.prisma.userOrganization.findUnique({
        where: { id: userOrganizationId },
        select: { organizationId: true },
      });
      orgId = userOrg?.organizationId;
    }
    if (!orgId) {
      // Defensive — shouldn't happen, fall back to no access.
      return new Set<string>();
    }

    // Fast path: org has zero private channels → behave exactly like before
    // ('ALL' shortcut means "no per-channel filter applied").
    const privateCount = await this.prisma.channel.count({
      where: { organizationId: orgId, visibility: 'PRIVATE', deletedAt: null },
    });
    if (privateCount === 0) return 'ALL';

    // Slow path: at least one private channel exists. Materialize the
    // exact set so private channels without a grant are excluded — even
    // for OWNERs.
    const channels = await this.prisma.channel.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        OR: [
          { visibility: 'ORG' },
          {
            visibility: 'PRIVATE',
            channelAgents: { some: { userOrganizationId } },
          },
        ],
      },
      select: { id: true },
    });
    return new Set(channels.map((c) => c.id));
  }

  /**
   * Resolve um ChannelAccess num Set concreto de channelIds: expande o
   * atalho 'ALL' e derruba ids que não são canal vivo desta org.
   *
   * O filtro importa porque ChannelAgent sobrevive ao soft-delete do canal
   * — sem ele, o Set de um AGENT carrega grants órfãos que não existem em
   * lugar nenhum da UI.
   */
  async materializeAccess(
    organizationId: string,
    access: ChannelAccess,
  ): Promise<Set<string>> {
    const channels = await this.prisma.channel.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true },
    });
    const ids = channels.map((c) => c.id);
    if (access === 'ALL') return new Set(ids);
    return new Set(ids.filter((id) => access.has(id)));
  }

  /** Versão sempre-materializada de getAccessibleChannelIds. */
  async getAccessibleChannelIdSet(
    userOrganizationId: string,
    role: OrgRole,
    organizationId: string,
  ): Promise<Set<string>> {
    const access = await this.getAccessibleChannelIds(
      userOrganizationId,
      role,
      organizationId,
    );
    return this.materializeAccess(organizationId, access);
  }

  hasAccess(access: ChannelAccess, channelId: string): boolean {
    return access === 'ALL' || access.has(channelId);
  }

  assertChannelAccess(access: ChannelAccess, channelId: string): void {
    if (!this.hasAccess(access, channelId)) {
      throw new ForbiddenException('You do not have access to this channel');
    }
  }

  async assertConversationAccess(
    access: ChannelAccess,
    conversationId: string,
  ): Promise<void> {
    if (access === 'ALL') return;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channelId: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    this.assertChannelAccess(access, conversation.channelId);
  }

  /**
   * Look up the membership for a user in an org. Throws if not found.
   * Used by the admin endpoints that take `memberId` (a user id) in URL.
   */
  async getMembership(organizationId: string, userId: string) {
    const membership = await this.prisma.userOrganization.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { id: true, role: true, userId: true },
    });
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }
    return membership;
  }

  /**
   * Grants explícitos do membro, recortados pelo que o CALLER enxerga.
   *
   * OWNER/ADMIN também aparecem com grants aqui: `bypass` só quer dizer
   * "herda os canais ORG sem precisar de grant" — canal PRIVATE exige
   * grant explícito pra qualquer role, então devolver [] pra eles (como
   * era antes) escondia da UI justamente o que ela existe pra editar.
   */
  async listMemberChannels(
    organizationId: string,
    userId: string,
    callerAccess: ChannelAccess,
  ) {
    const membership = await this.getMembership(organizationId, userId);
    const scope = await this.materializeAccess(organizationId, callerAccess);
    const grants = await this.prisma.channelAgent.findMany({
      where: { userOrganizationId: membership.id },
      select: { channelId: true },
    });
    return {
      bypass: this.isBypassRole(membership.role),
      role: membership.role,
      // Fora do escopo do caller não sai daqui: grant em canal privado
      // alheio (ou em canal já removido) não vaza nem some no próximo save.
      channelIds: grants.map((g) => g.channelId).filter((id) => scope.has(id)),
    };
  }

  /**
   * Replace the set of channel grants for a member, DENTRO do que o caller
   * enxerga. Returns the diff (added + removed) so callers can push live
   * socket-room updates without forcing a reconnect.
   *
   * O recorte por escopo é o que impede um save feito por quem só vê metade
   * dos canais de apagar os grants da outra metade.
   */
  async setMemberChannels(
    organizationId: string,
    userId: string,
    channelIds: string[],
    grantedById: string,
    callerAccess: ChannelAccess,
  ): Promise<{ added: string[]; removed: string[]; userId: string }> {
    const membership = await this.getMembership(organizationId, userId);
    // OWNER/ADMIN ainda bypassam canais ORG sem grant, mas grants explícitos
    // continuam relevantes pra canais PRIVATE — então a operação é válida.

    // O escopo já vem filtrado por org + canal vivo, então cobre também os
    // ids de outra org e os de canal removido.
    const scope = await this.materializeAccess(organizationId, callerAccess);
    const outOfScope = channelIds.filter((id) => !scope.has(id));
    if (outOfScope.length) {
      throw new ForbiddenException(
        'You cannot grant channels you do not have access to.',
      );
    }

    const existing = await this.prisma.channelAgent.findMany({
      where: { userOrganizationId: membership.id },
      select: { channelId: true },
    });
    const existingSet = new Set(existing.map((e) => e.channelId));
    const targetSet = new Set(channelIds);

    const toAdd = channelIds.filter((id) => !existingSet.has(id));
    // Revoga só o que o caller poderia ter concedido. Um grant fora do
    // escopo dele não é apagado por um payload que sequer o menciona.
    const toRemove = [...existingSet].filter(
      (id) => scope.has(id) && !targetSet.has(id),
    );

    await this.prisma.$transaction([
      ...(channelIds.length ? [this.prisma.channelAgent.updateMany({
        where: { userOrganizationId: membership.id, channelId: { in: channelIds } },
        data: { isManual: true },
      })] : []),
      ...(toRemove.length
        ? [
            this.prisma.channelAgent.deleteMany({
              where: {
                userOrganizationId: membership.id,
                channelId: { in: toRemove },
              },
            }),
          ]
        : []),
      ...toAdd.map((channelId) =>
        this.prisma.channelAgent.create({
          data: {
            channelId,
            userOrganizationId: membership.id,
            grantedById,
          },
        }),
      ),
    ]);

    return { added: toAdd, removed: toRemove, userId: membership.userId };
  }

  async addChannelAgent(
    organizationId: string,
    channelId: string,
    userId: string,
    grantedById: string,
  ): Promise<{ userId: string }> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const membership = await this.getMembership(organizationId, userId);
    // Pra canais PRIVATE até OWNER/ADMIN precisa de grant explícito —
    // por isso não bloqueamos mais a operação por role.

    await this.prisma.channelAgent.upsert({
      where: {
        channelId_userOrganizationId: {
          channelId,
          userOrganizationId: membership.id,
        },
      },
      update: { isManual: true },
      create: {
        channelId,
        userOrganizationId: membership.id,
        grantedById,
      },
    });

    return { userId: membership.userId };
  }

  async removeChannelAgent(
    organizationId: string,
    channelId: string,
    userId: string,
  ): Promise<{ userId: string }> {
    const membership = await this.getMembership(organizationId, userId);
    await this.prisma.channelAgent.deleteMany({
      where: {
        channelId,
        userOrganizationId: membership.id,
      },
    });
    return { userId: membership.userId };
  }

  async listChannelAgents(organizationId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const grants = await this.prisma.channelAgent.findMany({
      where: { channelId },
      include: {
        userOrganization: {
          include: {
            user: {
              select: { id: true, name: true, email: true, avatarUrl: true },
            },
          },
        },
      },
    });
    return grants.map((g) => ({
      grantId: g.id,
      grantedAt: g.grantedAt,
      user: g.userOrganization.user,
      role: g.userOrganization.role,
    }));
  }

  /**
   * Switch a channel between ORG (everyone in the org sees it) and
   * PRIVATE (only explicit grants see it). When flipping to PRIVATE,
   * we auto-grant the caller so they don't lock themselves out — and
   * if no other grants exist, only they keep access. The caller can
   * then add others through the normal grant API.
   */
  async setChannelVisibility(
    channelId: string,
    organizationId: string,
    visibility: 'ORG' | 'PRIVATE',
    callerUserOrganizationId: string,
  ): Promise<{ id: string; visibility: 'ORG' | 'PRIVATE' }> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, deletedAt: null },
      select: { id: true, visibility: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    if (channel.visibility === visibility) {
      return { id: channel.id, visibility };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.channel.update({
        where: { id: channelId },
        data: { visibility },
      });

      if (visibility === 'PRIVATE') {
        // Auto-grant ao caller pra ele não perder acesso ao próprio canal.
        await tx.channelAgent.upsert({
          where: {
            channelId_userOrganizationId: {
              channelId,
              userOrganizationId: callerUserOrganizationId,
            },
          },
          update: { isManual: true },
          create: {
            channelId,
            userOrganizationId: callerUserOrganizationId,
            grantedById: null,
          },
        });
      }
    });

    return { id: channel.id, visibility };
  }

  /**
   * Members eligible to handle a conversation in the given channel — used by
   * the assignee picker. Includes OWNER/ADMIN (always eligible) and AGENTs
   * with an explicit grant. Excludes inactive users.
   */
  async listEligibleAgents(organizationId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, deletedAt: null },
      select: { id: true, visibility: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    // Pra canal PRIVATE, OWNER/ADMIN não é elegível automaticamente — só
    // membros com grant explícito aparecem na lista de assignees.
    const baseWhere =
      channel.visibility === 'PRIVATE'
        ? { channelAgents: { some: { channelId } } }
        : {
            OR: [
              { role: { in: [OrgRole.OWNER, OrgRole.ADMIN] } },
              { channelAgents: { some: { channelId } } },
            ],
          };

    const memberships = await this.prisma.userOrganization.findMany({
      where: {
        organizationId,
        user: { isActive: true, deletedAt: null },
        ...baseWhere,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
      },
    });
    return memberships.map((m) => ({
      ...m.user,
      role: m.role,
    }));
  }
}
