import { ChannelType } from '@prisma/client';
import { InboundMessageProcessor } from './inbound-message.processor';
import { MessageContentType } from '../../channel-hub/ports/types';

/**
 * Falha no processamento precisa LIBERAR o claim de idempotência — senão o
 * retry do BullMQ cai em `duplicate_claim` e a mensagem some.
 */
function build() {
  const idempotency = {
    claimProcessing: jest.fn().mockResolvedValue(true),
    releaseClaim: jest.fn().mockResolvedValue(undefined),
    markProcessed: jest.fn().mockResolvedValue(undefined),
  };
  const contactResolver = {
    resolve: jest.fn().mockRejectedValue(new Error('db down')),
  };
  const webhookEvents = {
    markFailed: jest.fn().mockResolvedValue(undefined),
    markProcessed: jest.fn().mockResolvedValue(undefined),
  };
  const deps: any[] = [
    {}, // prisma
    idempotency,
    contactResolver,
    {}, // conversationResolver
    {}, // realtimeGateway
    {}, // instagramEnricher
    {}, // zappfyEnricher
    webhookEvents,
    {}, // agentRouter
    {}, // agentRunner
    {}, // transcription
    {}, // outbox
    {}, // watchdog
    {}, // salesRecovery
    {}, // leadOnboarding
    {}, // socialCommentsIngest
    {}, // chatbotQueue
  ];
  const processor = new (InboundMessageProcessor as any)(...deps) as InboundMessageProcessor;
  return { processor, idempotency, webhookEvents };
}

const job = {
  name: 'process-inbound',
  data: {
    channelId: 'ch_1',
    organizationId: 'org_1',
    webhookEventId: 'evt_1',
    message: {
      externalMessageId: 'ext_1',
      externalContactId: 'a@b.com',
      channelType: ChannelType.GMAIL,
      timestamp: new Date(),
      type: MessageContentType.TEXT,
      content: { text: 'oi' },
      rawPayload: {},
    },
  },
} as any;

describe('InboundMessageProcessor — idempotency claim on failure', () => {
  it('releases (deletes) the claim and rethrows so BullMQ retries', async () => {
    const { processor, idempotency, webhookEvents } = build();

    await expect(processor.process(job)).rejects.toThrow('db down');

    expect(idempotency.releaseClaim).toHaveBeenCalledWith('ext_1', 'ch_1');
    expect(idempotency.markProcessed).not.toHaveBeenCalled();
    expect(webhookEvents.markFailed).toHaveBeenCalledWith('evt_1', 'db down');
  });

  it('a retry after a failure re-acquires the claim and is not dropped', async () => {
    const { processor, idempotency } = build();
    await expect(processor.process(job)).rejects.toThrow();
    await expect(processor.process(job)).rejects.toThrow();
    // Both attempts reached the processing path (claim was available again).
    expect(idempotency.claimProcessing).toHaveBeenCalledTimes(2);
    expect(idempotency.releaseClaim).toHaveBeenCalledTimes(2);
  });
});
