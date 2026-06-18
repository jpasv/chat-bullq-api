import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { deriveGroupJid } from '../segments/group-jid.util';
import { UpdateProjectDto } from './dto/project.dto';

/** Resumo do projeto anexado às conversas/listas. */
export interface ProjectSummary {
  groupJid: string;
  name: string;
  hoppeId: string | null;
  responsibleUserId: string | null;
  responsible: { id: string; name: string; avatarUrl: string | null } | null;
  status: string | null;
  metadata: Record<string, unknown>;
  exists: boolean;
}

interface OrgGroupConv {
  id: string;
  channelId: string;
  lastMessageAt: Date | null;
  jid: string;
  groupName: string | null;
}

const RESPONSIBLE_SELECT = {
  select: { id: true, name: true, avatarUrl: true },
} as const;

const PROJECT_INCLUDE = { responsible: RESPONSIBLE_SELECT } as const;
type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof PROJECT_INCLUDE }>;

function emptyToNull(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length ? t : null;
}

/**
 * Grupo = Projeto. Entidade keyed por (org, group_jid). A ligação com as
 * conversas é POR LEITURA (deriva o JID); nada é alterado nas conversas.
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── helpers ──────────────────────────────────────────────────────────

  /** Carrega a conversa, valida que é grupo da org e deriva o JID + nome. */
  private async jidForConversation(
    organizationId: string,
    conversationId: string,
  ): Promise<{ jid: string; groupName: string | null }> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null },
      select: {
        channelId: true,
        isGroup: true,
        contact: {
          select: {
            name: true,
            channels: { select: { channelId: true, externalId: true } },
          },
        },
      },
    });
    if (!conv) throw new NotFoundException('Conversa não encontrada');
    if (!conv.isGroup) {
      throw new BadRequestException('A conversa não é um grupo');
    }
    const jid = deriveGroupJid(conv);
    if (!jid) {
      throw new BadRequestException('Não foi possível identificar o grupo (JID)');
    }
    return { jid, groupName: conv.contact?.name ?? null };
  }

  /** Conversas de grupo da org com o JID derivado (uma linha por conversa). */
  private async loadOrgGroupConvs(
    organizationId: string,
  ): Promise<OrgGroupConv[]> {
    const convs = await this.prisma.conversation.findMany({
      where: { organizationId, isGroup: true, deletedAt: null },
      select: {
        id: true,
        channelId: true,
        lastMessageAt: true,
        contact: {
          select: {
            name: true,
            channels: { select: { channelId: true, externalId: true } },
          },
        },
      },
    });
    const out: OrgGroupConv[] = [];
    for (const c of convs) {
      const jid = deriveGroupJid(c);
      if (!jid) continue;
      out.push({
        id: c.id,
        channelId: c.channelId,
        lastMessageAt: c.lastMessageAt,
        jid,
        groupName: c.contact?.name ?? null,
      });
    }
    return out;
  }

  private toSummary(
    project: ProjectRow | null,
    fallback: { jid: string; groupName: string | null },
  ): ProjectSummary {
    return {
      groupJid: fallback.jid,
      name: project?.name ?? fallback.groupName ?? fallback.jid,
      hoppeId: project?.hoppeId ?? null,
      responsibleUserId: project?.responsibleUserId ?? null,
      responsible: project?.responsible ?? null,
      status: project?.status ?? null,
      metadata: (project?.metadata as Record<string, unknown>) ?? {},
      exists: !!project,
    };
  }

  // ── leitura / escrita por conversa ──────────────────────────────────

  async getForConversation(
    organizationId: string,
    conversationId: string,
  ): Promise<ProjectSummary> {
    const { jid, groupName } = await this.jidForConversation(
      organizationId,
      conversationId,
    );
    const project = await this.prisma.project.findUnique({
      where: { uq_project_org_jid: { organizationId, groupJid: jid } },
      include: PROJECT_INCLUDE,
    });
    return this.toSummary(project, { jid, groupName });
  }

  async updateForConversation(
    organizationId: string,
    conversationId: string,
    dto: UpdateProjectDto,
  ): Promise<ProjectSummary> {
    const { jid, groupName } = await this.jidForConversation(
      organizationId,
      conversationId,
    );

    if (dto.responsibleUserId) {
      const member = await this.prisma.userOrganization.findFirst({
        where: { organizationId, userId: dto.responsibleUserId },
        select: { id: true },
      });
      if (!member) {
        throw new BadRequestException(
          'Responsável precisa ser um membro da organização',
        );
      }
    }

    const existing = await this.prisma.project.findUnique({
      where: { uq_project_org_jid: { organizationId, groupJid: jid } },
    });

    const mergedMetadata =
      dto.metadata !== undefined
        ? {
            ...((existing?.metadata as Record<string, unknown>) ?? {}),
            ...dto.metadata,
          }
        : undefined;

    const data: Prisma.ProjectUncheckedUpdateInput = {
      name: dto.name?.trim() || existing?.name || groupName || jid,
      ...(dto.hoppeId !== undefined ? { hoppeId: emptyToNull(dto.hoppeId) } : {}),
      ...(dto.responsibleUserId !== undefined
        ? { responsibleUserId: emptyToNull(dto.responsibleUserId) }
        : {}),
      ...(dto.status !== undefined ? { status: emptyToNull(dto.status) } : {}),
      ...(mergedMetadata !== undefined
        ? { metadata: mergedMetadata as Prisma.InputJsonValue }
        : {}),
      ...(existing?.deletedAt ? { deletedAt: null, isActive: true } : {}),
    };

    const project = existing
      ? await this.prisma.project.update({
          where: { id: existing.id },
          data,
          include: PROJECT_INCLUDE,
        })
      : await this.prisma.project.create({
          data: {
            organizationId,
            groupJid: jid,
            name: dto.name?.trim() || groupName || jid,
            hoppeId: emptyToNull(dto.hoppeId) ?? null,
            responsibleUserId: emptyToNull(dto.responsibleUserId) ?? null,
            status: emptyToNull(dto.status) ?? null,
            metadata: (mergedMetadata ?? {}) as Prisma.InputJsonValue,
          },
          include: PROJECT_INCLUDE,
        });

    return this.toSummary(project, { jid, groupName });
  }

  // ── anexar a conversas (inbox / detalhe) ────────────────────────────

  /** Map JID → ProjectSummary, para anexar nas conversas de grupo. */
  async attachByJids(
    organizationId: string,
    jids: string[],
  ): Promise<Map<string, ProjectSummary>> {
    const map = new Map<string, ProjectSummary>();
    const unique = Array.from(new Set(jids));
    if (unique.length === 0) return map;
    const projects = await this.prisma.project.findMany({
      where: { organizationId, groupJid: { in: unique }, deletedAt: null },
      include: PROJECT_INCLUDE,
    });
    for (const p of projects) {
      map.set(p.groupJid, this.toSummary(p, { jid: p.groupJid, groupName: p.name }));
    }
    return map;
  }

  // ── filtro da inbox (resolve → conversas representantes) ─────────────

  async resolveFilter(
    organizationId: string,
    filter: { hoppeId?: string; responsibleUserId?: string; status?: string },
  ): Promise<{ representativeIds: string[]; memberChannelIds: string[] }> {
    const where: Prisma.ProjectWhereInput = { organizationId, deletedAt: null };
    if (filter.hoppeId) where.hoppeId = filter.hoppeId;
    if (filter.responsibleUserId) where.responsibleUserId = filter.responsibleUserId;
    if (filter.status) where.status = filter.status;

    const projects = await this.prisma.project.findMany({
      where,
      select: { groupJid: true },
    });
    const jidSet = new Set(projects.map((p) => p.groupJid));
    if (jidSet.size === 0) return { representativeIds: [], memberChannelIds: [] };

    const convs = await this.loadOrgGroupConvs(organizationId);
    const repByJid = new Map<string, OrgGroupConv>();
    const channelIds = new Set<string>();
    for (const c of convs) {
      if (!jidSet.has(c.jid)) continue;
      channelIds.add(c.channelId);
      const cur = repByJid.get(c.jid);
      const t = c.lastMessageAt?.getTime() ?? 0;
      const curT = cur?.lastMessageAt?.getTime() ?? 0;
      if (!cur || t > curT) repByJid.set(c.jid, c);
    }
    return {
      representativeIds: Array.from(repByJid.values()).map((c) => c.id),
      memberChannelIds: Array.from(channelIds),
    };
  }

  // ── página de Projetos (1 linha por grupo da org) ───────────────────

  async list(
    organizationId: string,
    filter: { hoppeId?: string; responsibleUserId?: string; status?: string; search?: string },
  ): Promise<
    Array<
      ProjectSummary & { representativeConversationId: string; channelIds: string[] }
    >
  > {
    const convs = await this.loadOrgGroupConvs(organizationId);
    // representante + canais por JID
    const repByJid = new Map<string, OrgGroupConv>();
    const channelsByJid = new Map<string, Set<string>>();
    for (const c of convs) {
      if (!channelsByJid.has(c.jid)) channelsByJid.set(c.jid, new Set());
      channelsByJid.get(c.jid)!.add(c.channelId);
      const cur = repByJid.get(c.jid);
      const t = c.lastMessageAt?.getTime() ?? 0;
      const curT = cur?.lastMessageAt?.getTime() ?? 0;
      if (!cur || t > curT) repByJid.set(c.jid, c);
    }

    const projectMap = await this.attachByJids(
      organizationId,
      Array.from(repByJid.keys()),
    );

    const search = filter.search?.trim().toLowerCase();
    const rows: Array<
      ProjectSummary & { representativeConversationId: string; channelIds: string[] }
    > = [];
    for (const [jid, rep] of repByJid) {
      const summary =
        projectMap.get(jid) ??
        this.toSummary(null, { jid, groupName: rep.groupName });
      // filtros (no projeto)
      if (filter.hoppeId && summary.hoppeId !== filter.hoppeId) continue;
      if (
        filter.responsibleUserId &&
        summary.responsibleUserId !== filter.responsibleUserId
      )
        continue;
      if (filter.status && summary.status !== filter.status) continue;
      if (search && !summary.name.toLowerCase().includes(search)) continue;
      rows.push({
        ...summary,
        representativeConversationId: rep.id,
        channelIds: Array.from(channelsByJid.get(jid) ?? []),
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  /** Valores distintos para os dropdowns de filtro (hoppe_id e status). */
  async filters(
    organizationId: string,
  ): Promise<{ hoppeIds: string[]; statuses: string[] }> {
    const projects = await this.prisma.project.findMany({
      where: { organizationId, deletedAt: null },
      select: { hoppeId: true, status: true },
    });
    const hoppeIds = new Set<string>();
    const statuses = new Set<string>();
    for (const p of projects) {
      if (p.hoppeId) hoppeIds.add(p.hoppeId);
      if (p.status) statuses.add(p.status);
    }
    return {
      hoppeIds: Array.from(hoppeIds).sort(),
      statuses: Array.from(statuses).sort(),
    };
  }
}
