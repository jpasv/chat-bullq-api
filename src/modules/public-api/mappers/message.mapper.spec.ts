import { mapMessage } from './message.mapper';

describe('mapMessage', () => {
  const raw = {
    id: 'm1', conversationId: 'cv1', direction: 'OUTBOUND', type: 'TEXT',
    content: { text: 'oi' }, status: 'SENT', externalId: 'wamid.x',
    senderId: 'u1', senderName: 'Atendente', sentAt: new Date('2026-03-01T10:00:00Z'),
    deliveredAt: null, readAt: null, metadata: { foo: 1 }, createdAt: new Date('2026-03-01T09:59:00Z'),
    failedReason: null, revokedAt: null,
  };

  it('expõe campos públicos da mensagem e omite internos (metadata, revokedAt)', () => {
    const out = mapMessage(raw as any);
    expect(out).toEqual({
      id: 'm1', conversationId: 'cv1', direction: 'OUTBOUND', type: 'TEXT',
      content: { text: 'oi' }, status: 'SENT', externalId: 'wamid.x',
      senderId: 'u1', senderName: 'Atendente',
      sentAt: new Date('2026-03-01T10:00:00Z'), deliveredAt: null, readAt: null,
      createdAt: new Date('2026-03-01T09:59:00Z'),
    });
    expect((out as any).metadata).toBeUndefined();
    expect((out as any).revokedAt).toBeUndefined();
  });
});
