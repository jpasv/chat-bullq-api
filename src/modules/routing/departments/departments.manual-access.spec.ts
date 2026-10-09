import { DepartmentsRepository } from './departments.repository';
import { ChannelAccessService } from '../../iam/channel-access/channel-access.service';

describe('Manual versus department channel grants', () => {
  function setup(manual?: boolean) {
    let grant: any = manual === undefined ? null : { channelId: 'channel', userOrganizationId: 'member', isManual: manual };
    let members = 0;
    const tx: any = {
      department: { findUniqueOrThrow: jest.fn(async () => ({ channelId: 'channel' })) },
      departmentAgent: {
        count: jest.fn(async () => members),
        create: jest.fn(async () => { members++; return {}; }),
        deleteMany: jest.fn(async () => { members--; return { count: 1 }; }),
      },
      channelAgent: {
        upsert: jest.fn(async ({ create, update }) => { grant = grant ? { ...grant, ...update } : create; }),
        deleteMany: jest.fn(async ({ where }) => { if (grant?.isManual === where.isManual) grant = null; }),
        findMany: jest.fn(async () => grant ? [grant] : []),
        updateMany: jest.fn(async ({ data }) => { if (grant) Object.assign(grant, data); }),
      },
      channel: { findFirst: jest.fn(async () => ({ id: 'channel' })), findMany: jest.fn(async () => [{ id: 'channel' }]) },
      userOrganization: { findUnique: jest.fn(async () => ({ id: 'member', userId: 'user', role: 'AGENT' })) },
    };
    tx.$transaction = jest.fn(async work => typeof work === 'function' ? work(tx) : Promise.all(work));
    return { repository: new DepartmentsRepository(tx), access: new ChannelAccessService(tx), grant: () => grant };
  }

  it('preserves an existing manual grant after joining and leaving the last department', async () => {
    const s = setup(true);
    await s.repository.addAgent('dept', 'member');
    await s.repository.removeAgent('dept', 'member');
    expect(s.grant()).toMatchObject({ isManual: true });
  });

  it('removes a derived grant only after the last membership', async () => {
    const s = setup();
    await s.repository.addAgent('dept1', 'member');
    await s.repository.addAgent('dept2', 'member');
    expect(s.grant()).toMatchObject({ isManual: false });
    await s.repository.removeAgent('dept1', 'member');
    expect(s.grant()).not.toBeNull();
    await s.repository.removeAgent('dept2', 'member');
    expect(s.grant()).toBeNull();
  });

  it.each(['single', 'bulk'])('promotes derived grants on an explicit %s grant', async mode => {
    const s = setup();
    await s.repository.addAgent('dept', 'member');
    if (mode === 'single') await s.access.addChannelAgent('org', 'channel', 'user', 'actor');
    else await s.access.setMemberChannels('org', 'user', ['channel'], 'actor', 'ALL');
    await s.repository.removeAgent('dept', 'member');
    expect(s.grant()).toMatchObject({ isManual: true });
  });
});
