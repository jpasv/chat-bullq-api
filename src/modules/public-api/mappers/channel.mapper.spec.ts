import { mapChannel } from './channel.mapper';

describe('mapChannel', () => {
  it('expõe campos públicos e omite segredos (config, webhookSecret)', () => {
    const out = mapChannel({
      id: 'ch1', organizationId: 'org1', name: 'Vendas', type: 'WHATSAPP_CLOUD',
      isActive: true, visibility: 'ORG', aiEnabled: null,
      createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'), deletedAt: null,
      config: { accessToken: 'SECRET', phoneNumberId: 'x' }, webhookSecret: 'SECRET2',
    } as any);
    expect(out).toEqual({
      id: 'ch1', name: 'Vendas', type: 'WHATSAPP_CLOUD',
      isActive: true, visibility: 'ORG', aiEnabled: null, createdAt: new Date('2026-01-01'),
    });
    expect((out as any).config).toBeUndefined();
    expect((out as any).webhookSecret).toBeUndefined();
    expect((out as any).organizationId).toBeUndefined();
  });
});
