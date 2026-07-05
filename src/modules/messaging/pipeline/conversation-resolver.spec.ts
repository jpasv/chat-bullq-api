import { AutomationTrigger, ConversationStatus } from '@prisma/client';
import { ConversationResolverService } from './conversation-resolver.service';

describe('ConversationResolverService.resolve', () => {
  const organizationId = 'org-1';
  const channelId = 'ch-1';
  const contactId = 'contact-1';

  const buildService = (prisma: any, outbox: any) => {
    const idempotency = {
      withLock: (_key: string, fn: () => Promise<any>) => fn(),
    };
    return new ConversationResolverService(
      prisma as any,
      idempotency as any,
      outbox as any,
    );
  };

  it('CREATE: emits CONVERSATION_CREATED once with the expected payload and returns isNew', async () => {
    const txMock = {
      conversation: {
        create: jest.fn().mockResolvedValue({
          id: 'conv-new',
          status: ConversationStatus.PENDING,
        }),
      },
      conversationAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };

    const prisma = {
      conversation: {
        // fast-path findOpen -> null, locked findOpen -> null, lastClosed -> null
        findFirst: jest.fn().mockResolvedValue(null),
      },
      conversationAuditLog: { create: jest.fn() },
      $transaction: jest.fn((fn: any) => fn(txMock)),
    };

    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const service = buildService(prisma, outbox);

    const result = await service.resolve(organizationId, channelId, contactId);

    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const [, trigger, payload] = outbox.enqueue.mock.calls[0];
    expect(trigger).toBe(AutomationTrigger.CONVERSATION_CREATED);
    expect(payload).toMatchObject({
      organizationId,
      contactId,
      conversationId: 'conv-new',
      channelId,
    });
    expect(result.isNew).toBe(true);
  });

  it('REOPEN: does not emit any event when a recently-closed conversation is reopened', async () => {
    const lastClosed = {
      id: 'conv-closed',
      status: ConversationStatus.CLOSED,
      closedAt: new Date(Date.now() - 3600_000), // ~1h ago -> < 24h
      updatedAt: new Date(Date.now() - 3600_000),
    };

    const findFirst = jest
      .fn()
      // fast-path findOpen -> null
      .mockResolvedValueOnce(null)
      // locked findOpen -> null
      .mockResolvedValueOnce(null)
      // lastClosed lookup -> recently-closed conversation
      .mockResolvedValueOnce(lastClosed);

    const prisma = {
      conversation: {
        findFirst,
        update: jest.fn().mockResolvedValue({}),
      },
      conversationAuditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };

    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const service = buildService(prisma, outbox);

    const result = await service.resolve(organizationId, channelId, contactId);

    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(result.wasReopened).toBe(true);
  });
});
