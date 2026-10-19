import { createHmac } from 'crypto';
import axios from 'axios';
import { ChannelType } from '@prisma/client';
import { MembersOutboundAdapter } from './members.outbound-adapter';
import { MessageContentType } from '../../ports/types';
import { OutboundMessageProcessor } from '../../../messaging/pipeline/outbound-message.processor';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const CALLBACK_SECRET = 'cbsec_456';
const channel = {
  id: 'ch_members',
  type: ChannelType.MEMBERS,
  config: { callbackUrl: 'https://api.example.com/support/bullq/webhook', callbackSecret: CALLBACK_SECRET },
} as any;

const adapter = new MembersOutboundAdapter();

beforeEach(() => {
  mockedAxios.post.mockReset();
  mockedAxios.post.mockResolvedValue({ status: 200, data: { ok: true } } as any);
});

function lastCall() {
  const [url, body, opts] = mockedAxios.post.mock.calls[0] as [string, string, any];
  return { url, body, opts, json: JSON.parse(body) };
}

describe('MembersOutboundAdapter.sendMessage', () => {
  it('posts the signed message callback with agentName and unprefixed text', async () => {
    const result = await adapter.sendMessage(channel, 'user:42', {
      type: MessageContentType.TEXT,
      content: { text: 'Olá, posso ajudar!' },
      membersContext: {
        conversationExternalId: 'sc_1',
        messageId: 'msg_bullq_1',
        agentName: 'Carla',
        createdAt: '2026-10-19T12:01:00.000Z',
      },
    });

    const { url, body, opts, json } = lastCall();
    expect(url).toBe('https://api.example.com/support/bullq/webhook');
    expect(json).toEqual({
      event: 'message',
      conversationId: 'sc_1',
      message: {
        id: 'msg_bullq_1',
        text: 'Olá, posso ajudar!',
        agentName: 'Carla',
        createdAt: '2026-10-19T12:01:00.000Z',
      },
    });
    expect(json.message.text).not.toMatch(/^\*/);
    const expectedSig = `sha256=${createHmac('sha256', CALLBACK_SECRET).update(body).digest('hex')}`;
    expect(opts.headers['X-Bullq-Signature']).toBe(expectedSig);
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.timeout).toBe(10_000);
    expect(result.externalId).toBe('msg_bullq_1');
  });

  it('sends agentName null when unknown', async () => {
    await adapter.sendMessage(channel, 'x', {
      type: MessageContentType.TEXT,
      content: { text: 'oi' },
      membersContext: {
        conversationExternalId: 'sc_1',
        messageId: 'm2',
        agentName: null,
        createdAt: '2026-10-19T12:01:00.000Z',
      },
    });
    expect(lastCall().json.message.agentName).toBeNull();
  });

  it('fails (→ BullMQ retry) when the callback errors', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Request failed with status code 502'));
    await expect(
      adapter.sendMessage(channel, 'x', {
        type: MessageContentType.TEXT,
        content: { text: 'oi' },
        membersContext: {
          conversationExternalId: 'sc_1',
          messageId: 'm3',
          agentName: null,
          createdAt: '2026-10-19T12:01:00.000Z',
        },
      }),
    ).rejects.toThrow('502');
  });

  it('rejects non-text messages and messages without thread context', async () => {
    await expect(
      adapter.sendMessage(channel, 'x', {
        type: MessageContentType.IMAGE,
        content: { mediaUrl: 'https://x/y.png' },
        membersContext: {
          conversationExternalId: 'sc_1',
          messageId: 'm4',
          agentName: null,
          createdAt: '2026-10-19T12:01:00.000Z',
        },
      }),
    ).rejects.toThrow(/texto/);
    await expect(
      adapter.sendMessage(channel, 'x', { type: MessageContentType.TEXT, content: { text: 'oi' } }),
    ).rejects.toThrow(/externalThreadId/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

describe('MembersOutboundAdapter.onConversationClosed', () => {
  it('posts the signed conversation_closed callback', async () => {
    await adapter.onConversationClosed(channel, {
      id: 'conv_1',
      externalThreadId: 'sc_1',
      closedAt: new Date('2026-10-19T13:00:00.000Z'),
    });
    const { body, opts, json } = lastCall();
    expect(json).toEqual({
      event: 'conversation_closed',
      conversationId: 'sc_1',
      closedAt: '2026-10-19T13:00:00.000Z',
    });
    expect(opts.headers['X-Bullq-Signature']).toBe(
      `sha256=${createHmac('sha256', CALLBACK_SECRET).update(body).digest('hex')}`,
    );
  });
});

describe('OutboundMessageProcessor.attachMembersContext', () => {
  it('fills conversation externalThreadId, message id, agent name and createdAt', async () => {
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'msg_1',
          createdAt: new Date('2026-10-19T12:01:00.000Z'),
          senderName: null,
          sender: { name: 'Carla' },
          conversation: { externalThreadId: 'sc_1' },
        }),
      },
    };
    const processor = new OutboundMessageProcessor(prisma as any, {} as any, {} as any, {} as any);
    const message: any = { type: MessageContentType.TEXT, content: { text: 'oi' } };
    await processor.attachMembersContext('msg_1', message);
    expect(message.membersContext).toEqual({
      conversationExternalId: 'sc_1',
      messageId: 'msg_1',
      agentName: 'Carla',
      createdAt: '2026-10-19T12:01:00.000Z',
    });
  });

  it('falls back to senderName (AI agent) when there is no user sender', async () => {
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'msg_2',
          createdAt: new Date('2026-10-19T12:01:00.000Z'),
          senderName: 'Lívia',
          sender: null,
          conversation: { externalThreadId: 'sc_1' },
        }),
      },
    };
    const processor = new OutboundMessageProcessor(prisma as any, {} as any, {} as any, {} as any);
    const message: any = { type: MessageContentType.TEXT, content: { text: 'oi' } };
    await processor.attachMembersContext('msg_2', message);
    expect(message.membersContext.agentName).toBe('Lívia');
  });
});
