import { InboundMessageProcessor } from './inbound-message.processor';

describe('Inbound side-effect retries', () => {
  it('reuses dedup IDs when a persisted message retries after both enqueues', async () => {
    const processor = Object.create(InboundMessageProcessor.prototype) as any;
    const saved = { id: 'saved-message', type: 'TEXT' };
    Object.assign(processor, {
      logger: { log: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
      idempotency: { claimProcessing: jest.fn().mockResolvedValue('owner-token'), releaseClaim: jest.fn().mockResolvedValue(undefined) },
      contactResolver: { resolve: jest.fn().mockResolvedValue({ contactId: 'contact', isNew: false }) },
      conversationResolver: { resolve: jest.fn().mockResolvedValue({ conversationId: 'conv', status: 'BOT' }) },
      prisma: { $transaction: jest.fn().mockResolvedValue({ message: saved, isNew: false }) },
      realtimeGateway: { emitToChannel: jest.fn(), emitToConversation: jest.fn() },
      checkActiveBotForChannel: jest.fn().mockResolvedValue(true),
      chatbotQueue: { add: jest.fn().mockResolvedValue({}) },
      inboundQueue: { add: jest.fn().mockResolvedValue({}) },
      webhookEvents: { markProcessed: jest.fn().mockRejectedValueOnce(new Error('mark failed')).mockResolvedValue(undefined), markFailed: jest.fn() },
      watchdog: { scheduleCheck: jest.fn().mockResolvedValue(undefined) },
      salesRecovery: { onInboundReply: jest.fn().mockResolvedValue(undefined) },
    });
    const job = { name: 'process-message', data: { channelId: 'channel', organizationId: 'org', webhookEventId: 'event', message: { externalMessageId: 'external', channelType: 'GMAIL', content: { text: 'hello' } } } };
    await expect(processor.process(job)).rejects.toThrow('mark failed');
    expect(processor.idempotency.releaseClaim).toHaveBeenCalledWith('external', 'channel', 'owner-token');
    await processor.process(job);
    for (const [queue, prefix] of [[processor.chatbotQueue, 'chatbot'], [processor.inboundQueue, 'ai']] as const) {
      expect(queue.add).toHaveBeenCalledTimes(2);
      const options = queue.add.mock.calls.map((call: any[]) => call[2]);
      expect(options[0].deduplication).toEqual({ id: `${prefix}-saved-message`, ttl: 86400000 });
      expect(options[1].deduplication).toEqual(options[0].deduplication);
    }
  });

  it('consumes AI dispatch without reclaiming the inbound message', async () => {
    const processor = Object.create(InboundMessageProcessor.prototype) as any;
    processor.transcription = { transcribe: jest.fn().mockResolvedValue(undefined) };
    processor.tryAiAgent = jest.fn().mockResolvedValue(undefined);
    await processor.process({ name: 'dispatch-ai', data: { conversationId: 'conv', messageId: 'message', organizationId: 'org', type: 'AUDIO' } });
    expect(processor.transcription.transcribe).toHaveBeenCalledWith('message', 'org');
    expect(processor.tryAiAgent).toHaveBeenCalledWith('conv', 'message');
  });
});
