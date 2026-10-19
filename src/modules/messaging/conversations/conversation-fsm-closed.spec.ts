import { ChannelType, ConversationStatus } from '@prisma/client';
import { ConversationFsmService } from './conversation-fsm.service';
import { CONVERSATION_CLOSED_JOB } from '../pipeline/outbound-jobs.constants';

function build(opts: { channelType: ChannelType; hook: boolean; queueFails?: boolean }) {
  const prisma = {
    conversation: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'conv_1',
        status: ConversationStatus.OPEN,
        organizationId: 'org_1',
        contactId: 'ct_1',
        channelId: 'ch_1',
      }),
    },
    channel: { findUnique: jest.fn().mockResolvedValue({ type: opts.channelType }) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        conversation: { update: jest.fn() },
        conversationAuditLog: { create: jest.fn() },
      }),
    ),
  };
  const adapter: any = {};
  if (opts.hook) adapter.onConversationClosed = jest.fn();
  const registry = {
    hasAdapter: jest.fn().mockReturnValue(true),
    getOutbound: jest.fn().mockReturnValue(adapter),
  };
  const queue = {
    add: opts.queueFails
      ? jest.fn().mockRejectedValue(new Error('redis down'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const fsm = new ConversationFsmService(
    prisma as any,
    { requestRating: jest.fn().mockResolvedValue(undefined) } as any,
    { enqueue: jest.fn() } as any,
    registry as any,
    queue as any,
  );
  return { fsm, queue };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('ConversationFsmService — conversation_closed hook', () => {
  it('enqueues the async conversation-closed job for MEMBERS', async () => {
    const { fsm, queue } = build({ channelType: ChannelType.MEMBERS, hook: true });
    await fsm.transition('conv_1', ConversationStatus.CLOSED, 'user_1');
    await flush();
    expect(queue.add).toHaveBeenCalledWith(
      CONVERSATION_CLOSED_JOB,
      expect.objectContaining({ conversationId: 'conv_1', channelId: 'ch_1', closedAt: expect.any(String) }),
      expect.objectContaining({ attempts: 5 }),
    );
  });

  it('does nothing for channels without the hook', async () => {
    const { fsm, queue } = build({ channelType: ChannelType.WHATSAPP_ZAPPFY, hook: false });
    await fsm.transition('conv_1', ConversationStatus.CLOSED, 'user_1');
    await flush();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('close never fails because of the callback enqueue', async () => {
    const { fsm } = build({ channelType: ChannelType.MEMBERS, hook: true, queueFails: true });
    await expect(fsm.transition('conv_1', ConversationStatus.CLOSED, 'user_1')).resolves.toBeUndefined();
    await flush();
  });
});
