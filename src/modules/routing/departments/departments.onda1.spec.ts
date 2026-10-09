import { BadRequestException } from '@nestjs/common';
import { DepartmentsRepository } from './departments.repository';
import { DepartmentsService } from './departments.service';

function setup(channelId: string | null = 'channel') {
  const tx = {
    department: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'dept', channelId, agents: [{ userOrganizationId: 'member' }] }), update: jest.fn() },
    departmentAgent: { create: jest.fn().mockResolvedValue({ id: 'link' }), deleteMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn().mockResolvedValue(1) },
    channelAgent: { upsert: jest.fn(), deleteMany: jest.fn() },
    channel: { updateMany: jest.fn() }, conversation: { count: jest.fn().mockResolvedValue(0) },
  };
  const prisma = { $transaction: jest.fn(async work => work(tx)) };
  return { tx, repository: new DepartmentsRepository(prisma as any) };
}

describe('Channel access derived from department membership', () => {
  it('grants access atomically when a member joins a channel department', async () => {
    const { repository, tx } = setup(); await repository.addAgent('dept', 'member');
    expect(tx.channelAgent.upsert).toHaveBeenCalledWith({ where: { channelId_userOrganizationId: { channelId: 'channel', userOrganizationId: 'member' } }, create: { channelId: 'channel', userOrganizationId: 'member', isManual: false }, update: {} });
  });
  it('general departments do not grant access to any channel', async () => {
    const { repository, tx } = setup(null); await repository.addAgent('dept', 'member');
    expect(tx.channelAgent.upsert).not.toHaveBeenCalled();
  });
  it('keeps access when another active department of the same channel includes this member', async () => {
    const { repository, tx } = setup(); await repository.removeAgent('dept', 'member');
    expect(tx.departmentAgent.count).toHaveBeenCalledWith({ where: { userOrganizationId: 'member', isActive: true, department: { channelId: 'channel', deletedAt: null } } });
    expect(tx.channelAgent.deleteMany).not.toHaveBeenCalled();
  });
  it('removes access only on the last membership, scoped to that channel', async () => {
    const { repository, tx } = setup(); tx.departmentAgent.count.mockResolvedValue(0); await repository.removeAgent('dept', 'member');
    expect(tx.channelAgent.deleteMany).toHaveBeenCalledWith({ where: { channelId: 'channel', userOrganizationId: 'member', isManual: false } });
  });
  it('moves grants with a department and clears obsolete channel defaults', async () => {
    const { repository, tx } = setup(); tx.departmentAgent.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await repository.changeChannel('dept', 'new-channel');
    expect(tx.channel.updateMany).toHaveBeenCalledWith({ where: { defaultDepartmentId: 'dept' }, data: { defaultDepartmentId: null } });
    expect(tx.channelAgent.deleteMany).toHaveBeenCalledWith({ where: { channelId: 'channel', userOrganizationId: 'member', isManual: false } });
    expect(tx.channelAgent.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { channelId: 'new-channel', userOrganizationId: 'member', isManual: false } }));
  });
  it('does not move a department with conversations on another channel', async () => {
    const { repository, tx } = setup(); tx.conversation.count.mockResolvedValue(1);
    await expect(repository.changeChannel('dept', 'new-channel')).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.department.update).not.toHaveBeenCalled();
  });
  it('rejects a channel outside the organization on create and edit', async () => {
    const repo = { validateChannel: jest.fn().mockResolvedValue(null), findById: jest.fn().mockResolvedValue({ organizationId: 'org' }), create: jest.fn(), update: jest.fn() };
    const service = new DepartmentsService(repo as any);
    await expect(service.create('org', { name: 'Vendas', channelId: 'other-org' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('dept', 'org', { channelId: 'other-org' })).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.create).not.toHaveBeenCalled(); expect(repo.update).not.toHaveBeenCalled();
  });
});
