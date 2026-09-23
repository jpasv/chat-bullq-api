import { RealtimeGateway } from './realtime.gateway';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

describe('Realtime conversation channel access', () => {
  it.each(['OWNER', 'ADMIN', 'AGENT'])('requires a grant for %s', async (role) => {
    const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue({ channelId: 'private', organizationId: 'org', channel: { deletedAt: null, organizationId: 'org' } }) } };
    const gateway = new RealtimeGateway({} as any, {} as any, { setActiveConversation: jest.fn() } as any, prisma as any, {} as any);
    const client = { data: { authReady: true, organizationId: 'org', role, channelIds: [] }, join: jest.fn(), emit: jest.fn() };
    await gateway.handleJoinConversation(client as any, { conversationId: 'conv' });
    expect(client.join).not.toHaveBeenCalled();
    client.data.channelIds = ['private'] as any;
    await gateway.handleJoinConversation(client as any, { conversationId: 'conv' });
    expect(client.join).toHaveBeenCalledWith('conv:conv');
  });
  it.each([null, new Date()])('ALL is limited to live channels (deletedAt %s)', async (deletedAt) => {
    const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue({ channelId: 'public', organizationId: 'org', channel: { deletedAt, organizationId: 'org' } }) } };
    const gateway = new RealtimeGateway({} as any, {} as any, { setActiveConversation: jest.fn() } as any, prisma as any, {} as any);
    const client = { data: { authReady: true, organizationId: 'org', role: 'ADMIN', channelIds: 'ALL' }, join: jest.fn(), emit: jest.fn() };
    await gateway.handleJoinConversation(client as any, { conversationId: 'conv' });
    expect(client.join).toHaveBeenCalledTimes(deletedAt ? 0 : 1);
  });
  it('materializes ALL at handshake for admins without private channels', async () => {
    const prisma = { channel: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([{ id: 'public' }]) } };
    const access = new ChannelAccessService(prisma as any);
    const gateway = new RealtimeGateway({} as any, {} as any, {} as any, prisma as any, access);
    expect(await (gateway as any).resolveChannelRoomsForMembership('org', 'member', 'ADMIN')).toEqual(['public']);
    expect(prisma.channel.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org', deletedAt: null } }));
  });
});
