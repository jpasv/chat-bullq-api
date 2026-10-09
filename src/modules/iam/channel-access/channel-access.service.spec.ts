import { ForbiddenException } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { ChannelAccessService } from './channel-access.service';

/**
 * Regra central: quem gerencia só concede — e só revoga — dentro dos canais
 * que ele próprio enxerga. Canal PRIVATE exige grant explícito pra qualquer
 * role, inclusive OWNER/ADMIN.
 */
const ORG = 'org_1';

function buildService(rows: {
  /** Canais vivos da org. */
  channels?: string[];
  /** Grants do membro-alvo. */
  grants?: string[];
  membership?: { id: string; role: OrgRole; userId: string } | null;
}) {
  const prisma = {
    channel: {
      findMany: jest
        .fn()
        .mockResolvedValue((rows.channels ?? []).map((id) => ({ id }))),
      count: jest.fn().mockResolvedValue(0),
    },
    channelAgent: {
      findMany: jest
        .fn()
        .mockResolvedValue((rows.grants ?? []).map((channelId) => ({ channelId }))),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    userOrganization: {
      findUnique: jest.fn().mockResolvedValue(
        rows.membership === undefined
          ? { id: 'uo_target', role: OrgRole.AGENT, userId: 'user_target' }
          : rows.membership,
      ),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  return { service: new ChannelAccessService(prisma as any), prisma };
}

describe('ChannelAccessService.listMemberChannels', () => {
  it('devolve os grants de um ADMIN em vez de lista vazia', async () => {
    const { service } = buildService({
      channels: ['ch_org', 'ch_priv'],
      grants: ['ch_org', 'ch_priv'],
      membership: { id: 'uo_target', role: OrgRole.ADMIN, userId: 'user_x' },
    });

    const result = await service.listMemberChannels(ORG, 'user_x', 'ALL');

    expect(result.bypass).toBe(true);
    expect(result.channelIds.sort()).toEqual(['ch_org', 'ch_priv']);
  });

  it('esconde grant em canal que o caller não enxerga', async () => {
    const { service } = buildService({
      channels: ['ch_a', 'ch_alheio'],
      grants: ['ch_a', 'ch_alheio'],
    });

    const result = await service.listMemberChannels(
      ORG,
      'user_x',
      new Set(['ch_a']),
    );

    expect(result.channelIds).toEqual(['ch_a']);
  });

  it('esconde grant órfão de canal removido mesmo com acesso ALL', async () => {
    const { service } = buildService({
      // ch_deletado não volta na query de canais vivos.
      channels: ['ch_a'],
      grants: ['ch_a', 'ch_deletado'],
    });

    const result = await service.listMemberChannels(ORG, 'user_x', 'ALL');

    expect(result.channelIds).toEqual(['ch_a']);
  });
});

describe('ChannelAccessService.setMemberChannels', () => {
  it('preserva grant fora do escopo do caller ao substituir o conjunto', async () => {
    const { service } = buildService({
      channels: ['ch_a', 'ch_b', 'ch_alheio'],
      grants: ['ch_a', 'ch_alheio'],
    });

    // Caller só enxerga ch_a e ch_b. Manda só ch_b: ch_a sai, ch_alheio fica.
    const result = await service.setMemberChannels(
      ORG,
      'user_x',
      ['ch_b'],
      'actor_1',
      new Set(['ch_a', 'ch_b']),
    );

    expect(result.added).toEqual(['ch_b']);
    expect(result.removed).toEqual(['ch_a']);
    expect(result.removed).not.toContain('ch_alheio');
  });

  it('recusa conceder canal fora do escopo do caller', async () => {
    const { service } = buildService({
      channels: ['ch_a', 'ch_alheio'],
      grants: [],
    });

    await expect(
      service.setMemberChannels(
        ORG,
        'user_x',
        ['ch_alheio'],
        'actor_1',
        new Set(['ch_a']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('recusa id de canal removido em vez de aceitar silenciosamente', async () => {
    const { service } = buildService({
      channels: ['ch_a'],
      grants: [],
    });

    await expect(
      service.setMemberChannels(
        ORG,
        'user_x',
        ['ch_a', 'ch_deletado'],
        'actor_1',
        'ALL',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('não mexe em nada quando o conjunto já está aplicado', async () => {
    const { service, prisma } = buildService({
      channels: ['ch_a', 'ch_b'],
      grants: ['ch_a', 'ch_b'],
    });

    const result = await service.setMemberChannels(
      ORG,
      'user_x',
      ['ch_a', 'ch_b'],
      'actor_1',
      'ALL',
    );

    expect(result).toMatchObject({ added: [], removed: [] });
    expect(prisma.channelAgent.create).not.toHaveBeenCalled();
    expect(prisma.channelAgent.deleteMany).not.toHaveBeenCalled();
  });
});
