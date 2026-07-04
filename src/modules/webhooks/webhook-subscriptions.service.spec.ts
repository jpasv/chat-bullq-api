import { WebhookSubscriptionsService } from './webhook-subscriptions.service';

function build() {
  const prisma = {
    webhookSubscription: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 's1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 's1', organizationId: 'o' }),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 's1', organizationId: 'o', ...data })),
      delete: jest.fn().mockResolvedValue({ id: 's1' }),
    },
    webhookDelivery: { create: jest.fn().mockResolvedValue({ id: 'del1' }), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn().mockImplementation((arr) => Promise.all(arr)),
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  return { prisma, queue, service: new WebhookSubscriptionsService(prisma as any, queue as any) };
}

describe('WebhookSubscriptionsService', () => {
  it('create gera secret com prefixo whsec_ e persiste', async () => {
    const { prisma, service } = build();
    const out = await service.create('o', 'u1', { url: 'https://x/h', events: ['MESSAGE_RECEIVED'] as any });
    expect(prisma.webhookSubscription.create).toHaveBeenCalled();
    expect(out.secret).toMatch(/^whsec_/);
  });

  it('findOne rejeita subscription de outra org', async () => {
    const { prisma, service } = build();
    prisma.webhookSubscription.findFirst.mockResolvedValue(null);
    await expect(service.findOne('s1', 'other')).rejects.toThrow();
  });

  it('update reativando (isActive=true) zera consecutiveFailures e disabledAt', async () => {
    const { prisma, service } = build();
    const out = await service.update('s1', 'o', { isActive: true });
    const arg = prisma.webhookSubscription.update.mock.calls[0][0];
    expect(arg.data.consecutiveFailures).toBe(0);
    expect(arg.data.disabledAt).toBeNull();
    expect(out.isActive).toBe(true);
  });

  it('ping cria delivery PING e enfileira', async () => {
    const { prisma, queue, service } = build();
    await service.ping('s1', 'o');
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'PING' }) }));
    expect(queue.add).toHaveBeenCalled();
  });
});
