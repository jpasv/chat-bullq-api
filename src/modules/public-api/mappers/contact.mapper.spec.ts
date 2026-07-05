import { mapContact } from './contact.mapper';

describe('mapContact', () => {
  const raw = {
    id: 'c1', organizationId: 'org1', name: 'Ana', phone: '5511999', email: null,
    avatarUrl: 'http://x/a.png', notes: 'vip', metadata: { foo: 1 },
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'), deletedAt: null,
    channels: [{ externalId: '5511999', profileName: 'Ana W', channel: { id: 'ch1', type: 'WHATSAPP_CLOUD', name: 'Vendas' } }],
    tags: [{ tag: { id: 't1', name: 'Lead', color: '#f00' } }],
    _count: { conversations: 4 },
  };

  it('expõe apenas campos públicos e omite internos (organizationId, deletedAt)', () => {
    const out = mapContact(raw as any);
    expect(out).toMatchObject({
      id: 'c1', name: 'Ana', phone: '5511999', email: null, avatarUrl: 'http://x/a.png',
      notes: 'vip', metadata: { foo: 1 }, conversationsCount: 4,
    });
    expect((out as any).organizationId).toBeUndefined();
    expect((out as any).deletedAt).toBeUndefined();
  });

  it('mapeia canais e tags para shape público', () => {
    const out = mapContact(raw as any);
    expect(out.channels).toEqual([{ id: 'ch1', type: 'WHATSAPP_CLOUD', name: 'Vendas', externalId: '5511999', profileName: 'Ana W' }]);
    expect(out.tags).toEqual([{ id: 't1', name: 'Lead', color: '#f00' }]);
  });

  it('tolera contato sem channels/tags/_count', () => {
    const out = mapContact({ id: 'c2', createdAt: new Date(), updatedAt: new Date() } as any);
    expect(out.channels).toEqual([]);
    expect(out.tags).toEqual([]);
    expect(out.conversationsCount).toBe(0);
  });
});
