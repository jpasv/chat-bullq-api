import { Logger } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Regra: canal PRIVATE só chega (socket) a quem tem grant explícito, até pra
 * OWNER/ADMIN — igual ao REST. Dois pontos cobertos aqui:
 *  - `resyncChannelRoom`: quando a visibilidade muda, quem já estava conectado
 *    sai/entra da room na hora, sem depender de reconnect.
 *  - `join:conversation`: admin não pula a checagem de canal; se o canal não
 *    estiver no snapshot do handshake, re-resolve no banco antes de recusar.
 */
const ORG = 'org_1';
const CH = 'ch_priv';

type FakeSocket = {
  id: string;
  data: Record<string, any>;
  rooms: Set<string>;
  connected: boolean;
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
};

function fakeSocket(
  id: string,
  data: Record<string, any>,
  rooms: string[] = [],
): FakeSocket {
  const s: FakeSocket = {
    id,
    data: { authReady: true, organizationId: ORG, ...data },
    rooms: new Set(rooms),
    connected: true,
    join: jest.fn((room: string) => s.rooms.add(room)),
    leave: jest.fn((room: string) => s.rooms.delete(room)),
    emit: jest.fn(),
  };
  return s;
}

function buildGateway(opts: {
  sockets: FakeSocket[];
  channel?: {
    visibility: 'ORG' | 'PRIVATE';
    deletedAt?: Date | null;
    grants: string[];
  } | null;
  conversation?: { channelId: string; organizationId: string } | null;
  freshAccess?: string[];
}) {
  const prisma = {
    channel: {
      findFirst: jest.fn().mockResolvedValue(
        opts.channel === undefined || opts.channel === null
          ? null
          : {
              visibility: opts.channel.visibility,
              deletedAt: opts.channel.deletedAt ?? null,
              channelAgents: opts.channel.grants.map((userOrganizationId) => ({
                userOrganizationId,
              })),
            },
      ),
    },
    conversation: {
      findUnique: jest.fn().mockResolvedValue(opts.conversation ?? null),
    },
  };
  const channelAccess = {
    isBypassRole: (role: OrgRole) =>
      role === OrgRole.OWNER || role === OrgRole.ADMIN,
    getAccessibleChannelIdSet: jest
      .fn()
      .mockResolvedValue(new Set(opts.freshAccess ?? [])),
  };
  const presence = {
    setActiveConversation: jest.fn(),
    setOnline: jest.fn(),
    setOffline: jest.fn(),
  };
  const server = {
    in: jest.fn((room: string) => ({
      fetchSockets: async () => opts.sockets.filter((s) => s.rooms.has(room)),
    })),
    to: jest.fn(() => ({ emit: jest.fn() })),
  };
  const gateway = new RealtimeGateway(
    {} as any,
    {} as any,
    presence as any,
    prisma as any,
    channelAccess as any,
  );
  gateway.server = server as any;
  return { gateway, prisma, channelAccess, presence, server };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('RealtimeGateway.resyncChannelRoom', () => {
  it('canal PRIVATE: admin sem grant sai da room; quem tem grant entra', async () => {
    const admin = fakeSocket(
      's_admin',
      { userOrganizationId: 'uo_admin', role: OrgRole.ADMIN, channelIds: [CH, 'ch_org'] },
      [`org:${ORG}`, `channel:${CH}`, 'channel:ch_org'],
    );
    const owner = fakeSocket(
      's_owner',
      { userOrganizationId: 'uo_owner', role: OrgRole.OWNER, channelIds: ['ch_org'] },
      [`org:${ORG}`, 'channel:ch_org'],
    );
    const agentNoGrant = fakeSocket(
      's_agent',
      { userOrganizationId: 'uo_agent', role: OrgRole.AGENT, channelIds: [] },
      [`org:${ORG}`],
    );
    const { gateway } = buildGateway({
      sockets: [admin, owner, agentNoGrant],
      channel: { visibility: 'PRIVATE', grants: ['uo_owner'] },
    });

    await gateway.resyncChannelRoom(ORG, CH);

    // Admin sem grant: sai da room, snapshot atualizado, avisado.
    expect(admin.rooms.has(`channel:${CH}`)).toBe(false);
    expect(admin.data.channelIds).toEqual(['ch_org']);
    expect(admin.emit).toHaveBeenCalledWith('permissions:updated', {
      channelId: CH,
      granted: false,
    });

    // Owner com grant: entra na room.
    expect(owner.rooms.has(`channel:${CH}`)).toBe(true);
    expect(owner.data.channelIds).toEqual(['ch_org', CH]);
    expect(owner.emit).toHaveBeenCalledWith('permissions:updated', {
      channelId: CH,
      granted: true,
    });

    // Agent sem grant já estava fora: nada muda, nenhum aviso.
    expect(agentNoGrant.rooms.has(`channel:${CH}`)).toBe(false);
    expect(agentNoGrant.emit).not.toHaveBeenCalled();
  });

  it('canal volta pra ORG: admin entra de novo, agent continua precisando de grant', async () => {
    const admin = fakeSocket(
      's_admin',
      { userOrganizationId: 'uo_admin', role: OrgRole.ADMIN, channelIds: [] },
      [`org:${ORG}`],
    );
    const agentNoGrant = fakeSocket(
      's_agent',
      { userOrganizationId: 'uo_agent', role: OrgRole.AGENT, channelIds: [] },
      [`org:${ORG}`],
    );
    const agentGranted = fakeSocket(
      's_agent2',
      { userOrganizationId: 'uo_agent2', role: OrgRole.AGENT, channelIds: [] },
      [`org:${ORG}`],
    );
    const { gateway } = buildGateway({
      sockets: [admin, agentNoGrant, agentGranted],
      channel: { visibility: 'ORG', grants: ['uo_agent2'] },
    });

    await gateway.resyncChannelRoom(ORG, CH);

    expect(admin.rooms.has(`channel:${CH}`)).toBe(true);
    expect(agentGranted.rooms.has(`channel:${CH}`)).toBe(true);
    expect(agentNoGrant.rooms.has(`channel:${CH}`)).toBe(false);
    expect(agentNoGrant.emit).not.toHaveBeenCalled();
  });

  it('canal apagado: todo mundo sai da room', async () => {
    const admin = fakeSocket(
      's_admin',
      { userOrganizationId: 'uo_admin', role: OrgRole.ADMIN, channelIds: [CH] },
      [`org:${ORG}`, `channel:${CH}`],
    );
    const { gateway } = buildGateway({
      sockets: [admin],
      channel: { visibility: 'ORG', deletedAt: new Date(), grants: ['uo_admin'] },
    });

    await gateway.resyncChannelRoom(ORG, CH);

    expect(admin.rooms.has(`channel:${CH}`)).toBe(false);
    expect(admin.data.channelIds).toEqual([]);
  });

  it('socket de outra org não é tocado', async () => {
    const outsider = fakeSocket(
      's_out',
      { organizationId: 'org_2', userOrganizationId: 'uo_out', role: OrgRole.ADMIN, channelIds: [] },
      ['org:org_2'],
    );
    const { gateway } = buildGateway({
      sockets: [outsider],
      channel: { visibility: 'ORG', grants: [] },
    });

    await gateway.resyncChannelRoom(ORG, CH);

    expect(outsider.rooms.has(`channel:${CH}`)).toBe(false);
    expect(outsider.emit).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway.handleJoinConversation', () => {
  it('ADMIN sem grant em canal PRIVATE é recusado mesmo depois de re-resolver', async () => {
    const admin = fakeSocket(
      's_admin',
      { userId: 'u_admin', userOrganizationId: 'uo_admin', role: OrgRole.ADMIN, channelIds: ['ch_org'] },
      [`org:${ORG}`, 'channel:ch_org'],
    );
    const { gateway, channelAccess, presence } = buildGateway({
      sockets: [admin],
      conversation: { channelId: CH, organizationId: ORG },
      freshAccess: ['ch_org'],
    });

    await gateway.handleJoinConversation(admin as any, { conversationId: 'conv_1' });

    expect(channelAccess.getAccessibleChannelIdSet).toHaveBeenCalledWith(
      'uo_admin',
      OrgRole.ADMIN,
      ORG,
    );
    expect(admin.rooms.has('conv:conv_1')).toBe(false);
    expect(admin.emit).toHaveBeenCalledWith('join:conversation:error', {
      conversationId: 'conv_1',
      reason: 'no-channel-grant',
    });
    expect(presence.setActiveConversation).not.toHaveBeenCalled();
  });

  it('snapshot desatualizado mas acesso fresco libera: entra na conversa e na room do canal', async () => {
    const admin = fakeSocket(
      's_admin',
      { userId: 'u_admin', userOrganizationId: 'uo_admin', role: OrgRole.ADMIN, channelIds: ['ch_org'] },
      [`org:${ORG}`, 'channel:ch_org'],
    );
    const { gateway } = buildGateway({
      sockets: [admin],
      conversation: { channelId: 'ch_new', organizationId: ORG },
      freshAccess: ['ch_org', 'ch_new'],
    });

    await gateway.handleJoinConversation(admin as any, { conversationId: 'conv_2' });

    expect(admin.rooms.has('conv:conv_2')).toBe(true);
    expect(admin.rooms.has('channel:ch_new')).toBe(true);
    expect(admin.data.channelIds).toEqual(['ch_org', 'ch_new']);
    expect(admin.emit).toHaveBeenCalledWith('join:conversation:ack', {
      conversationId: 'conv_2',
    });
  });

  it('canal já no snapshot: entra direto sem consultar o banco de acesso', async () => {
    const agent = fakeSocket(
      's_agent',
      { userId: 'u_agent', userOrganizationId: 'uo_agent', role: OrgRole.AGENT, channelIds: [CH] },
      [`org:${ORG}`, `channel:${CH}`],
    );
    const { gateway, channelAccess } = buildGateway({
      sockets: [agent],
      conversation: { channelId: CH, organizationId: ORG },
    });

    await gateway.handleJoinConversation(agent as any, { conversationId: 'conv_3' });

    expect(channelAccess.getAccessibleChannelIdSet).not.toHaveBeenCalled();
    expect(agent.rooms.has('conv:conv_3')).toBe(true);
  });

  it('OWNER em conversa de outra org é recusado (org-mismatch)', async () => {
    const owner = fakeSocket(
      's_owner',
      { userId: 'u_owner', userOrganizationId: 'uo_owner', role: OrgRole.OWNER, channelIds: [CH] },
      [`org:${ORG}`, `channel:${CH}`],
    );
    const { gateway } = buildGateway({
      sockets: [owner],
      conversation: { channelId: CH, organizationId: 'org_2' },
    });

    await gateway.handleJoinConversation(owner as any, { conversationId: 'conv_4' });

    expect(owner.rooms.has('conv:conv_4')).toBe(false);
    expect(owner.emit).toHaveBeenCalledWith('join:conversation:error', {
      conversationId: 'conv_4',
      reason: 'org-mismatch',
    });
  });
});
