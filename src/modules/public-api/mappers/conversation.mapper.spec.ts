import { mapConversation } from './conversation.mapper';

describe('mapConversation', () => {
  const raw = {
    id: 'cv1', organizationId: 'org1', status: 'OPEN', channelId: 'ch1', contactId: 'c1',
    assignedToId: 'u1', departmentId: 'd1', subject: 'Dúvida', protocol: '2026-0001',
    isGroup: false, isArchived: false, lastMessageAt: new Date('2026-02-01'), closedAt: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-02-01'), deletedAt: null,
    channel: { id: 'ch1', type: 'WHATSAPP_CLOUD', name: 'Vendas' },
    contact: { id: 'c1', name: 'Ana', phone: '5511999' },
  };

  it('expõe campos públicos e resumo de canal/contato, omitindo internos', () => {
    const out = mapConversation(raw as any);
    expect(out).toMatchObject({
      id: 'cv1', status: 'OPEN', channelId: 'ch1', contactId: 'c1', assignedToId: 'u1',
      departmentId: 'd1', subject: 'Dúvida', protocol: '2026-0001', isGroup: false, isArchived: false,
    });
    expect(out.channel).toEqual({ id: 'ch1', type: 'WHATSAPP_CLOUD', name: 'Vendas' });
    expect(out.contact).toEqual({ id: 'c1', name: 'Ana', phone: '5511999' });
    expect((out as any).organizationId).toBeUndefined();
    expect((out as any).deletedAt).toBeUndefined();
  });

  it('tolera conversa sem channel/contact carregados', () => {
    const out = mapConversation({ id: 'cv2', status: 'CLOSED', createdAt: new Date(), updatedAt: new Date() } as any);
    expect(out.channel).toBeNull();
    expect(out.contact).toBeNull();
  });
});
