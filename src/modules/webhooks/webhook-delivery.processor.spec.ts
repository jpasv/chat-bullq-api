import axios from 'axios';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { signPayload } from './hmac.util';

jest.mock('axios');
const mockedPost = axios.post as jest.Mock;

const sub = { id: 'sub1', organizationId: 'o', url: 'https://x/h', secret: 'whsec_s', isActive: true, consecutiveFailures: 0 };
const delivery = { id: 'del1', subscriptionId: 'sub1', type: 'MESSAGE_RECEIVED', payload: { contactId: 'c' }, createdAt: new Date('2026-01-01'), subscription: sub };

function build() {
  const prisma = {
    webhookDelivery: { findUnique: jest.fn().mockResolvedValue(delivery), update: jest.fn().mockResolvedValue({}) },
    webhookSubscription: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(sub) },
  };
  const notifications = { notifyOrgAgents: jest.fn().mockResolvedValue(undefined) };
  const proc = new WebhookDeliveryProcessor(prisma as any, notifications as any);
  return { prisma, notifications, proc };
}

beforeEach(() => mockedPost.mockReset());

describe('WebhookDeliveryProcessor', () => {
  it('2xx → marca SUCCESS e zera consecutiveFailures', async () => {
    mockedPost.mockResolvedValue({ status: 200 });
    const { prisma, proc } = build();
    await proc.process({ data: { deliveryId: 'del1' }, attemptsMade: 0 } as any);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS' }) }));
    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 0 }) }));
  });

  it('não-2xx → relança (BullMQ retry)', async () => {
    mockedPost.mockResolvedValue({ status: 500 });
    const { proc } = build();
    await expect(proc.process({ data: { deliveryId: 'del1' }, attemptsMade: 0 } as any)).rejects.toThrow();
  });

  it('handleExhausted → DLQ + incrementa failures + auto-desativa após limite', async () => {
    const { prisma, notifications, proc } = build();
    prisma.webhookSubscription.findUnique.mockResolvedValue({ ...sub, consecutiveFailures: 9 });
    await proc.handleExhausted('del1');
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DLQ' }) }));
    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }));
    expect(notifications.notifyOrgAgents).toHaveBeenCalled();
  });

  it('onFailed não exaure enquanto ainda há tentativas restantes', async () => {
    const { prisma, proc } = build();
    const job = { data: { deliveryId: 'del1' }, attemptsMade: 2, opts: { attempts: 5 } };
    await proc.onFailed(job as any);
    expect(prisma.webhookDelivery.update.mock.calls.every((c: any[]) => c[0].data.status !== 'DLQ')).toBe(true);
  });

  it('onFailed exaure na última tentativa falha e marca DLQ', async () => {
    const { prisma, proc } = build();
    prisma.webhookSubscription.findUnique.mockResolvedValue({ ...sub, consecutiveFailures: 0 });
    const job = { data: { deliveryId: 'del1' }, attemptsMade: 5, opts: { attempts: 5 } };
    await proc.onFailed(job as any);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DLQ' }) }));
  });

  it('assinatura HMAC corresponde exatamente ao corpo enviado', async () => {
    mockedPost.mockResolvedValue({ status: 200 });
    const { proc } = build();
    await proc.process({ data: { deliveryId: 'del1' }, attemptsMade: 0 } as any);
    const [, sentBody, config] = mockedPost.mock.calls[0];
    expect(typeof sentBody).toBe('string');
    expect(config.headers['X-BullQ-Signature']).toBe(signPayload(sentBody, sub.secret));
  });

  it('subscription inativa → DLQ sem chamada HTTP', async () => {
    const { prisma, proc } = build();
    prisma.webhookDelivery.findUnique.mockResolvedValue({ ...delivery, subscription: { ...sub, isActive: false } });
    await proc.process({ data: { deliveryId: 'del1' }, attemptsMade: 0 } as any);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DLQ' }) }));
  });

  it('delivery inexistente → retorna sem chamar HTTP ou update', async () => {
    const { prisma, proc } = build();
    prisma.webhookDelivery.findUnique.mockResolvedValue(null);
    await proc.process({ data: { deliveryId: 'del1' }, attemptsMade: 0 } as any);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.update).not.toHaveBeenCalled();
  });
});
