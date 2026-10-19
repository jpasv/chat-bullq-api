import { PendingActionExecutorProcessor } from './pending-action-executor.processor';

function setup(resumedRuns: number) {
  const prisma = {
    aiAgentRun: { count: jest.fn().mockResolvedValue(resumedRuns) },
    conversation: { update: jest.fn().mockResolvedValue({}) },
    aiPendingAction: { update: jest.fn().mockResolvedValue({}) },
  };
  const storage = {
    get: jest.fn().mockResolvedValue({
      id: 'pa1',
      status: 'APPROVED',
      toolName: 'transferToHuman',
      conversationId: 'conv1',
      args: { reason: 'aula não encontrada' },
      createdAt: '2026-10-19T19:17:40.000Z',
    }),
  };
  const processor = new PendingActionExecutorProcessor(prisma as any, {} as any, storage as any);
  const job = { name: 'execute_pending', data: { pendingActionId: 'pa1' } } as any;
  return { prisma, processor, job };
}

describe('PendingActionExecutorProcessor transferToHuman', () => {
  it('desliga a IA quando a conversa não andou depois do pedido', async () => {
    const { prisma, processor, job } = setup(0);
    const result: any = await processor.process(job);
    expect(prisma.aiAgentRun.count).toHaveBeenCalledWith({
      where: {
        conversationId: 'conv1',
        startedAt: { gt: new Date('2026-10-19T19:17:40.000Z') },
        finalAction: 'REPLIED',
      },
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv1' }, data: { aiEnabled: false } });
    expect(result.ok).toBe(true);
  });

  it('não desliga a IA se ela respondeu depois do pedido (aprovação tardia)', async () => {
    const { prisma, processor, job } = setup(3);
    const result: any = await processor.process(job);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: 'conversa_seguiu' });
    expect(prisma.aiPendingAction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'EXECUTED' }) }),
    );
  });
});
