import { mapSubscription } from './webhook-subscription.mapper';

describe('mapSubscription', () => {
  const raw = {
    id: 's1', organizationId: 'o', url: 'https://x/hook', secret: 'whsec_abcdef123456',
    events: ['MESSAGE_RECEIVED'], isActive: true, description: 'meu hook',
    consecutiveFailures: 0, disabledAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
  };
  it('mascara o secret e omite organizationId', () => {
    const out = mapSubscription(raw as any);
    expect(out.secret).toBe('whsec_…3456');
    expect((out as any).organizationId).toBeUndefined();
    expect(out).toMatchObject({ id: 's1', url: 'https://x/hook', events: ['MESSAGE_RECEIVED'], isActive: true, consecutiveFailures: 0 });
  });
  it('inclui o secret cru só quando revealSecret=true (create)', () => {
    const out = mapSubscription(raw as any, true);
    expect(out.secret).toBe('whsec_abcdef123456');
  });
});
