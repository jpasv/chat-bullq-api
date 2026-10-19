import { ChannelType } from '@prisma/client';
import { MessagesService } from './messages.service';

/**
 * Texto do operador ganha o prefixo `*Nome*\n` nos canais de chat, mas NÃO
 * no canal MEMBERS (lá o nome vai separado em `agentName`).
 */
function build(channelType: ChannelType) {
  const outboundQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    conversation: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'conv_1',
        organizationId: 'org_1',
        channelId: 'ch_1',
        contactId: 'ct_1',
        assignedToId: 'user_1',
        aiEnabled: null,
        channel: { id: 'ch_1', type: channelType },
        contact: { name: 'Ana', channels: [{ channelId: 'ch_1', externalId: 'user:42' }] },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ aiAutoDisableOnHuman: false }) },
    conversationRead: { upsert: jest.fn().mockResolvedValue({}) },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Carla' }) },
  };
  const repository = { create: jest.fn().mockResolvedValue({ id: 'msg_1' }) };
  const realtime = {
    emitToUser: jest.fn(),
    emitToChannel: jest.fn(),
    emitToConversation: jest.fn(),
  };
  const service = new MessagesService(
    repository as any,
    prisma as any,
    realtime as any,
    { assertChannelAccess: jest.fn() } as any,
    { cancelCheck: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    outboundQueue as any,
  );
  return { service, outboundQueue };
}

describe('MessagesService.send — agent name signature', () => {
  it('MEMBERS: text goes without the *Name* prefix', async () => {
    const { service, outboundQueue } = build(ChannelType.MEMBERS);
    await service.send(
      { conversationId: 'conv_1', type: 'TEXT', content: { text: 'Olá!' } } as any,
      'user_1',
      'org_1',
    );
    const [, data] = outboundQueue.add.mock.calls[0];
    expect(data.message.content.text).toBe('Olá!');
  });

  it('WhatsApp: keeps the *Name* prefix', async () => {
    const { service, outboundQueue } = build(ChannelType.WHATSAPP_ZAPPFY);
    await service.send(
      { conversationId: 'conv_1', type: 'TEXT', content: { text: 'Olá!' } } as any,
      'user_1',
      'org_1',
    );
    const [, data] = outboundQueue.add.mock.calls[0];
    expect(data.message.content.text).toBe('*Carla*\nOlá!');
  });
});
