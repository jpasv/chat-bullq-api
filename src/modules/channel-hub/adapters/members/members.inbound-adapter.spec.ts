import { createHmac } from 'crypto';
import { ChannelType } from '@prisma/client';
import { MembersInboundAdapter } from './members.inbound-adapter';
import { MessageContentType } from '../../ports/types';

const SECRET = 'whsec_test_123';
const adapter = new MembersInboundAdapter();
const channel = { id: 'ch_members', type: ChannelType.MEMBERS, config: {} } as any;

const messageEvent = {
  event: 'message',
  conversation: { id: 'sc_1', tenantId: 't_1', tenantName: 'Escola X' },
  contact: { externalId: 'user:42', name: 'Ana', email: 'ana@x.com', phone: null },
  message: { id: 'sm_9', text: 'Preciso de ajuda', timestamp: '2026-10-19T12:00:00.000Z' },
};

const handoffEvent = {
  event: 'handoff',
  conversation: { id: 'sc_1', tenantId: null, tenantName: null },
  contact: { externalId: 'email:ana@x.com', name: null, email: 'ana@x.com', phone: null },
  handoff: { reason: 'quer reembolso', transcript: 'Membro: oi\nBot: olá', timestamp: '2026-10-19T11:59:00.000Z' },
};

function sign(raw: string, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

describe('MembersInboundAdapter — locator', () => {
  it('extracts channelId from X-Members-Channel', () => {
    expect(adapter.extractLocators({}, { 'x-members-channel': 'ch_members' })).toEqual([
      { channelId: 'ch_members' },
    ]);
    expect(adapter.extractLocators({}, {})).toEqual([]);
  });

  it('matches only the channel with that id', () => {
    expect(adapter.matchesChannel(channel, { channelId: 'ch_members' })).toBe(true);
    expect(adapter.matchesChannel(channel, { channelId: 'other' })).toBe(false);
    expect(adapter.matchesChannel(channel, {})).toBe(false);
  });
});

describe('MembersInboundAdapter — signature validation', () => {
  const raw = JSON.stringify(messageEvent);
  const body = Buffer.from(raw);

  it('accepts a valid sha256=<hex> HMAC of the raw body', () => {
    expect(adapter.validateWebhook({ 'x-members-signature': sign(raw) }, body, SECRET)).toBe(true);
  });

  it('accepts uppercase hex in the header', () => {
    const header = `sha256=${sign(raw).slice(7).toUpperCase()}`;
    expect(adapter.validateWebhook({ 'x-members-signature': header }, body, SECRET)).toBe(true);
  });

  it('rejects missing header', () => {
    expect(adapter.validateWebhook({}, body, SECRET)).toBe(false);
  });

  it('rejects signature made with another secret', () => {
    expect(
      adapter.validateWebhook({ 'x-members-signature': sign(raw, 'other') }, body, SECRET),
    ).toBe(false);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(raw.replace('Preciso', 'Precisa'));
    expect(adapter.validateWebhook({ 'x-members-signature': sign(raw) }, tampered, SECRET)).toBe(false);
  });

  it('rejects header without the sha256= prefix or truncated', () => {
    const hex = sign(raw).slice(7);
    expect(adapter.validateWebhook({ 'x-members-signature': hex }, body, SECRET)).toBe(false);
    expect(
      adapter.validateWebhook({ 'x-members-signature': `sha256=${hex.slice(0, 10)}` }, body, SECRET),
    ).toBe(false);
  });

  it('rejects when channel has no webhookSecret', () => {
    expect(adapter.validateWebhook({ 'x-members-signature': sign(raw) }, body, undefined)).toBe(false);
  });
});

describe('MembersInboundAdapter — parseWebhook', () => {
  it('normalizes a message event with thread id = members conversation id', () => {
    const out = adapter.parseWebhook(messageEvent, channel);
    expect(out.errors).toEqual([]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      externalMessageId: 'sm_9',
      externalContactId: 'user:42',
      contactName: 'Ana',
      channelType: ChannelType.MEMBERS,
      type: MessageContentType.TEXT,
      content: { text: 'Preciso de ajuda' },
      threadExternalId: 'sc_1',
      timestamp: new Date('2026-10-19T12:00:00.000Z'),
    });
  });

  it('handoff events produce no inbound message', () => {
    const out = adapter.parseWebhook(handoffEvent, channel);
    expect(out.messages).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it('invalid bodies are reported as errors', () => {
    const out = adapter.parseWebhook({ event: 'message', conversation: {} }, channel);
    expect(out.messages).toEqual([]);
    expect(out.errors[0].code).toBe('invalid_body');
  });
});
