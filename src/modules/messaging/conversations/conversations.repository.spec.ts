import { ConversationsRepository } from './conversations.repository';

describe('ConversationsRepository.countByStatus (RN-05 assignment scope)', () => {
  const buildRepo = (groupBy: jest.Mock) => {
    const prisma = { conversation: { groupBy } };
    return new ConversationsRepository(prisma as any);
  };

  it('escopa a contagem por assignedToId quando enforceAssignedToId é passado (AGENT)', async () => {
    const groupBy = jest.fn().mockResolvedValue([]);
    const repo = buildRepo(groupBy);

    await repo.countByStatus('org-1', undefined, 'user-agent');

    expect(groupBy).toHaveBeenCalledTimes(1);
    const arg = groupBy.mock.calls[0][0];
    expect(arg.where.assignedToId).toBe('user-agent');
    expect(arg.where.organizationId).toBe('org-1');
  });

  it('NÃO adiciona assignedToId quando enforceAssignedToId é undefined (OWNER/ADMIN)', async () => {
    const groupBy = jest.fn().mockResolvedValue([]);
    const repo = buildRepo(groupBy);

    await repo.countByStatus('org-1', undefined, undefined);

    const arg = groupBy.mock.calls[0][0];
    expect(arg.where.assignedToId).toBeUndefined();
  });

  it('combina o escopo de atribuição com o teto de canais acessíveis', async () => {
    const groupBy = jest.fn().mockResolvedValue([]);
    const repo = buildRepo(groupBy);

    await repo.countByStatus('org-1', ['ch-1', 'ch-2'], 'user-agent');

    const arg = groupBy.mock.calls[0][0];
    expect(arg.where.assignedToId).toBe('user-agent');
    expect(arg.where.channelId).toEqual({ in: ['ch-1', 'ch-2'] });
  });

  it('retorna vazio (sem query) quando o usuário não tem canais acessíveis', async () => {
    const groupBy = jest.fn().mockResolvedValue([]);
    const repo = buildRepo(groupBy);

    const result = await repo.countByStatus('org-1', [], 'user-agent');

    expect(result).toEqual({});
    expect(groupBy).not.toHaveBeenCalled();
  });
});
