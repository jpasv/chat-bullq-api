import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class DepartmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.DepartmentCreateInput) {
    return this.prisma.department.create({ data });
  }

  async findByOrg(organizationId: string) {
    return this.prisma.department.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async findById(id: string) {
    return this.prisma.department.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async update(id: string, data: Prisma.DepartmentUpdateInput) {
    return this.prisma.department.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return this.prisma.department.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async validateChannel(channelId: string, organizationId: string) {
    return this.prisma.channel.findFirst({ where: { id: channelId, organizationId, deletedAt: null } });
  }

  // Membership in any active department of a channel grants access to that
  // channel. Remove only derived grants after the LAST membership disappears;
  // an explicit grant survives independently of department membership.
  private async syncGrant(tx: Prisma.TransactionClient, channelId: string, userOrganizationId: string) {
    const count = await tx.departmentAgent.count({ where: {
      userOrganizationId, isActive: true, department: { channelId, deletedAt: null },
    } });
    if (count) await tx.channelAgent.upsert({
      where: { channelId_userOrganizationId: { channelId, userOrganizationId } },
      create: { channelId, userOrganizationId, isManual: false }, update: {},
    });
    else await tx.channelAgent.deleteMany({ where: { channelId, userOrganizationId, isManual: false } });
  }

  async changeChannel(id: string, channelId: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.department.findUniqueOrThrow({ where: { id }, include: { agents: true } });
      if (before.channelId === channelId) return before;
      // Existing conversations keep their channel and department; do not move
      // a department that would invalidate those assignments/defaults.
      const inUse = await tx.conversation.count({ where: { departmentId: id, ...(channelId ? { channelId: { not: channelId } } : {}) } });
      if (channelId && inUse) throw new BadRequestException('Departamento possui conversas em outro canal');
      await tx.channel.updateMany({ where: { defaultDepartmentId: id }, data: { defaultDepartmentId: null } });
      const result = await tx.department.update({ where: { id }, data: { channelId } });
      for (const member of before.agents) {
        if (before.channelId) await this.syncGrant(tx, before.channelId, member.userOrganizationId);
        if (channelId) await this.syncGrant(tx, channelId, member.userOrganizationId);
      }
      return result;
    });
  }

  async addAgent(departmentId: string, userOrganizationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const department = await tx.department.findUniqueOrThrow({ where: { id: departmentId } });
      const member = await tx.departmentAgent.create({ data: { departmentId, userOrganizationId, isActive: true } });
      if (department.channelId) await this.syncGrant(tx, department.channelId, userOrganizationId);
      return member;
    });
  }

  async removeAgent(departmentId: string, userOrganizationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const department = await tx.department.findUniqueOrThrow({ where: { id: departmentId } });
      const result = await tx.departmentAgent.deleteMany({ where: { departmentId, userOrganizationId } });
      if (department.channelId) await this.syncGrant(tx, department.channelId, userOrganizationId);
      return result;
    });
  }

  async findAgents(departmentId: string) {
    return this.prisma.departmentAgent.findMany({
      where: { departmentId },
      include: {
        userOrganization: {
          include: {
            user: { select: { id: true, name: true, email: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
  }

  async findDepartmentAgentByUser(
    departmentId: string,
    organizationId: string,
    userId: string,
  ) {
    return this.prisma.departmentAgent.findFirst({
      where: {
        departmentId,
        userOrganization: { userId, organizationId },
      },
    });
  }

  async clearDefaultForOrg(organizationId: string, exceptDepartmentId?: string) {
    return this.prisma.department.updateMany({
      where: {
        organizationId,
        deletedAt: null,
        isDefault: true,
        ...(exceptDepartmentId ? { id: { not: exceptDepartmentId } } : {}),
      },
      data: { isDefault: false },
    });
  }

  async findMembership(userId: string, organizationId: string) {
    return this.prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: { userId, organizationId },
      },
    });
  }
}
