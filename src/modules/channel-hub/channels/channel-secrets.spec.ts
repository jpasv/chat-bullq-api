import { maskChannel, restoreMaskedConfig, isMaskedValue } from './channel-secrets';

describe('channel secrets masking', () => {
  const channel = {
    id: 'ch_1',
    webhookSecret: 'abcdef0123456789abcdef',
    config: {
      callbackUrl: 'https://m/cb',
      callbackSecret: 'supersecretvalue1234',
      token: 'short',
      phoneNumberId: '123',
      nested: { accessToken: 'EAAG-very-long-token-xyz' },
    },
  };

  it('masks webhookSecret and secret-like config keys only', () => {
    const masked = maskChannel(channel) as any;
    expect(masked.webhookSecret).toBe('********cdef');
    expect(masked.config.callbackSecret).toBe('********1234');
    expect(masked.config.token).toBe('********');
    expect(masked.config.nested.accessToken).toBe('********-xyz');
    expect(masked.config.callbackUrl).toBe('https://m/cb');
    expect(masked.config.phoneNumberId).toBe('123');
    // não muta o original
    expect(channel.config.callbackSecret).toBe('supersecretvalue1234');
  });

  it('PATCH: masked placeholders are replaced by the stored values', () => {
    const masked = maskChannel(channel) as any;
    const incoming = { ...masked.config, callbackUrl: 'https://m/new' };
    const restored = restoreMaskedConfig(incoming, channel.config);
    expect(restored).toEqual({ ...channel.config, callbackUrl: 'https://m/new' });
    expect(isMaskedValue(masked.webhookSecret)).toBe(true);
  });

  it('PATCH: new values replace the stored ones', () => {
    const restored = restoreMaskedConfig({ callbackSecret: 'new-secret' }, channel.config);
    expect(restored).toEqual({ callbackSecret: 'new-secret' });
  });
});
