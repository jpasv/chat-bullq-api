import { WebhookDispatchService } from './webhook-dispatch.service';

describe('WebhookDispatchService', () => {
  const build = () => {
    const prisma = {
      webhookSubscription: { findMany: jest.fn().mockResolvedValue([{ id: 'sub1' }, { id: 'sub2' }]) },
      webhookDelivery: { create: jest.fn().mockImplementation(({ data }) => ({ id: `del-${data.subscriptionId}`, ...data })) },
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    return { prisma, queue, service: new WebhookDispatchService(prisma as any, queue as any) };
  };

  const event = { outboxEventId: 'evt1', organizationId: 'o', trigger: 'MESSAGE_RECEIVED', payload: { contactId: 'c', conversationId: 'cv', channelId: 'ch', messageId: 'm' } };

  it('cria uma delivery e enfileira um job por subscription ativa', async () => {
    const { prisma, queue, service } = build();
    await service.dispatch(event as any);
    expect(prisma.webhookSubscription.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'o', isActive: true, events: { has: 'MESSAGE_RECEIVED' } },
    });
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('usa jobId idempotente subscriptionId:outboxEventId', async () => {
    const { queue, service } = build();
    await service.dispatch(event as any);
    const opts = queue.add.mock.calls[0][2];
    expect(opts.jobId).toBe('sub1:evt1');
  });

  it('não faz nada quando não há subscription casando', async () => {
    const { prisma, queue, service } = build();
    prisma.webhookSubscription.findMany.mockResolvedValue([]);
    await service.dispatch(event as any);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
