import { mapWebhookData } from './webhook-payload.mapper';

describe('mapWebhookData', () => {
  it('MESSAGE_RECEIVED → ids relevantes', () => {
    const out = mapWebhookData('MESSAGE_RECEIVED', {
      organizationId: 'o', contactId: 'c', conversationId: 'cv', channelId: 'ch', messageId: 'm', body: 'oi', type: 'TEXT', actorId: null,
    });
    expect(out).toEqual({ contactId: 'c', conversationId: 'cv', channelId: 'ch', messageId: 'm' });
  });
  it('CONVERSATION_STATUS_CHANGED → inclui from/toStatus', () => {
    const out = mapWebhookData('CONVERSATION_STATUS_CHANGED', {
      organizationId: 'o', contactId: 'c', conversationId: 'cv', channelId: 'ch', fromStatus: 'OPEN', toStatus: 'CLOSED',
    });
    expect(out).toEqual({ contactId: 'c', conversationId: 'cv', channelId: 'ch', fromStatus: 'OPEN', toStatus: 'CLOSED' });
  });
  it('TAG_ADDED → inclui tagId', () => {
    const out = mapWebhookData('TAG_ADDED', { organizationId: 'o', contactId: 'c', conversationId: 'cv', tagId: 't' });
    expect(out).toEqual({ contactId: 'c', conversationId: 'cv', tagId: 't' });
  });
  it('trigger desconhecido → passa o payload como está', () => {
    const out = mapWebhookData('PING', { ping: true } as any);
    expect(out).toEqual({ ping: true });
  });
});
