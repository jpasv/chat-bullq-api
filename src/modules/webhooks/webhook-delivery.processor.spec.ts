import axios from 'axios';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';

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
});
