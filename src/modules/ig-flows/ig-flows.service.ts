import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { UpsertIgFlowDto } from './dto/upsert-ig-flow.dto';
import { validateIgFlowNodes } from './ig-flows.validator';

@Injectable()
export class IgFlowsService {
  constructor(private readonly prisma: PrismaService) {}

  list(orgId: string) {
    return this.prisma.igFlow.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
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
