import { OutboundMessageProcessor } from './outbound-message.processor';
import { NormalizedOutboundMessage } from '../../channel-hub/ports/types';

/**
 * attachEmailContext (GMAIL): monta threadId + In-Reply-To/References a
 * partir da conversa e da última msg inbound — é o que faz a resposta da
 * IA cair no thread certo do Gmail.
 */
function buildProcessor(rows: {
  message?: any;
  conversation?: any;
  lastInbound?: any;
}) {
  const prisma = {
    message: {
      findUnique: jest.fn().mockResolvedValue(rows.message ?? null),
      findFirst: jest.fn().mockResolvedValue(rows.lastInbound ?? null),
    },
    conversation: {
      findUnique: jest.fn().mockResolvedValue(rows.conversation ?? null),
    },
  };
  const processor = new OutboundMessageProcessor(
    prisma as any,
    {} as any, // adapterRegistry — não usado pelo método
    {} as any, // realtimeGateway
    {} as any, // idempotency
  );
  return { processor, prisma };
}

describe('OutboundMessageProcessor.attachEmailContext', () => {
  it('monta o contexto completo a partir da conversa + última inbound', async () => {
    const { processor } = buildProcessor({
      message: { conversationId: 'conv_1' },
      conversation: {
        externalThreadId: 'thread_1',
        subject: 'Dúvida sobre o produto',
      },
      lastInbound: {
        metadata: {
          rawPayload: {
            gmail: {
              threadId: 'thread_1',
              messageIdHeader: '<orig@mail.gmail.com>',
              references: '<primeiro@mail.gmail.com>',
              subject: 'Dúvida sobre o produto',
            },
          },
        },
      },
    });

    const message: NormalizedOutboundMessage = {
      type: 'TEXT' as any,
      content: { text: 'resposta' },
    };
    await (processor as any).attachEmailContext('msg_1', message);

    expect(message.emailContext).toEqual({
      threadId: 'thread_1',
      inReplyTo: '<orig@mail.gmail.com>',
      references: '<primeiro@mail.gmail.com>',
      subject: 'Dúvida sobre o produto',
    });
  });

  it('sem inbound anterior: contexto parcial só com dados da conversa', async () => {
    const { processor } = buildProcessor({
      message: { conversationId: 'conv_1' },
      conversation: { externalThreadId: 'thread_9', subject: 'Proposta' },
      lastInbound: null,
    });

    const message: NormalizedOutboundMessage = {
      type: 'TEXT' as any,
      content: { text: 'oi' },
    };
    await (processor as any).attachEmailContext('msg_1', message);

    expect(message.emailContext).toEqual({
      threadId: 'thread_9',
      inReplyTo: undefined,
      references: undefined,
      subject: 'Proposta',
    });
  });

  it('erro de banco não explode — envio segue sem contexto (best-effort)', async () => {
    const prisma = {
      message: {
        findUnique: jest.fn().mockRejectedValue(new Error('db down')),
        findFirst: jest.fn(),
      },
      conversation: { findUnique: jest.fn() },
    };
    const processor = new OutboundMessageProcessor(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const message: NormalizedOutboundMessage = {
      type: 'TEXT' as any,
      content: { text: 'oi' },
    };
    await expect(
      (processor as any).attachEmailContext('msg_1', message),
    ).resolves.toBeUndefined();
    expect(message.emailContext).toBeUndefined();
  });
});
