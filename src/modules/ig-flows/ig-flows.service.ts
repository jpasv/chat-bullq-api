import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { UpsertIgFlowDto } from './dto/upsert-ig-flow.dto';
import { validateIgFlowNodes } from './ig-flows.validator';

@Injectable()
export class IgFlowsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(orgId: string) {
    const flows = await this.prisma.igFlow.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    if (!flows.length) return [];
    const grouped = await this.prisma.igFlowRun.groupBy({
      by: ['flowId', 'status'],
      where: { flowId: { in: flows.map((f) => f.id) } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return flows.map((flow) => {
      const rows = grouped.filter((g) => g.flowId === flow.id);
      return { ...flow, stats: summarizeRuns(rows) };
    });
  }

  /** Resumo de execução do fluxo: status, onde as runs em aberto estão e eventos por nó/botão. */
  async stats(id: string, orgId: string) {
    await this.get(id, orgId);
    const [grouped, current, events] = await Promise.all([
      this.prisma.igFlowRun.groupBy({
        by: ['flowId', 'status'],
        where: { flowId: id },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.igFlowRun.groupBy({
        by: ['currentNodeId', 'status'],
        where: { flowId: id, status: { notIn: ['DONE'] } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ nodeId: string | null; event: string; count: bigint }[]>`
        SELECT e->>'nodeId' AS "nodeId", e->>'event' AS event, count(*) AS count
        FROM ig_flow_runs r, jsonb_array_elements(r.log) e
        WHERE r.flow_id = ${id}
        GROUP BY 1, 2`,
    ]);
    return {
      ...summarizeRuns(grouped),
      current: current.map((c) => ({ nodeId: c.currentNodeId, status: c.status, count: c._count._all })),
      events: events.map((e) => ({ nodeId: e.nodeId, event: e.event, count: Number(e.count) })),
    };
  }

  async get(id: string, orgId: string) {
    const flow = await this.prisma.igFlow.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
    if (!flow) throw new NotFoundException('Fluxo não encontrado');
    return flow;
  }

  create(orgId: string, dto: UpsertIgFlowDto) {
    const nodes = validateIgFlowNodes(dto.nodes, dto.startNodeId);
    return this.prisma.igFlow.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        isActive: dto.isActive ?? false,
        channelIds: dto.channelIds ?? [],
        triggerType: dto.triggerType,
        triggerConfig: (dto.triggerConfig ?? {}) as Prisma.InputJsonValue,
        nodes: nodes as unknown as Prisma.InputJsonValue,
        startNodeId: dto.startNodeId,
        priority: dto.priority ?? 0,
      },
    });
  }

  async update(id: string, orgId: string, dto: UpsertIgFlowDto) {
    await this.get(id, orgId);
    const nodes = validateIgFlowNodes(dto.nodes, dto.startNodeId);
    return this.prisma.igFlow.update({
      where: { id },
      data: {
        name: dto.name,
        isActive: dto.isActive ?? false,
        channelIds: dto.channelIds ?? [],
        triggerType: dto.triggerType,
        triggerConfig: (dto.triggerConfig ?? {}) as Prisma.InputJsonValue,
        nodes: nodes as unknown as Prisma.InputJsonValue,
        startNodeId: dto.startNodeId,
        priority: dto.priority ?? 0,
      },
    });
  }

  async setActive(id: string, orgId: string, isActive: boolean) {
    await this.get(id, orgId);
    return this.prisma.igFlow.update({ where: { id }, data: { isActive } });
  }

  async remove(id: string, orgId: string) {
    await this.get(id, orgId);
    await this.prisma.igFlow.update({ where: { id }, data: { isActive: false, deletedAt: new Date() } });
  }

  async runs(id: string, orgId: string, limit = 50) {
    await this.get(id, orgId);
    return this.prisma.igFlowRun.findMany({
      where: { flowId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }
}

function summarizeRuns(rows: { status: string; _count: { _all: number }; _max: { createdAt: Date | null } }[]) {
  const byStatus: Record<string, number> = {};
  let total = 0;
  let lastRunAt: Date | null = null;
  for (const r of rows) {
    byStatus[r.status] = r._count._all;
    total += r._count._all;
    if (r._max.createdAt && (!lastRunAt || r._max.createdAt > lastRunAt)) lastRunAt = r._max.createdAt;
  }
  return { total, byStatus, lastRunAt };
}
