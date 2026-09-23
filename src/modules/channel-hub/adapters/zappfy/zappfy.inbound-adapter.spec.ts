import { ConfigService } from '@nestjs/config';
import { ZappfyInboundAdapter } from './zappfy.inbound-adapter';
import { ZappfyMessageMapper } from './zappfy.message-mapper';

describe('Zappfy webhook authentication rollout', () => {
  it.each([false, true, 'false', 'true', undefined])('handles missing secrets with flag %s', (flag) => {
    const adapter = new ZappfyInboundAdapter(new ZappfyMessageMapper(), new ConfigService({ WEBHOOK_REQUIRE_AUTH: flag }));
    const warn = jest.spyOn((adapter as any).logger, 'warn').mockImplementation(() => {});
    expect(adapter.validateWebhook({}, Buffer.from('{}'), undefined, { id: 'ch1', config: {} } as any)).toBe(String(flag) !== 'true');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('channelId=ch1'));
  });
  it.each([false, true])('rejects invalid/missing tokens and accepts valid tokens with flag %s', (flag) => {
    const adapter = new ZappfyInboundAdapter(new ZappfyMessageMapper(), new ConfigService({ WEBHOOK_REQUIRE_AUTH: flag }));
    const channel = { config: { token: 'secret' } } as any;
    expect(adapter.validateWebhook({ token: 'wrong' }, Buffer.from('{}'), undefined, channel)).toBe(false);
    expect(adapter.validateWebhook({}, Buffer.from('{}'), undefined, channel)).toBe(false);
    expect(adapter.validateWebhook({ token: 'secret' }, Buffer.from('{}'), undefined, channel)).toBe(true);
    expect(adapter.validateWebhook({}, Buffer.from('{"instance":{"token":"secret"}}'), undefined, channel)).toBe(true);
    expect(adapter.validateWebhook({ token: 'wrong' }, Buffer.from('{"token":"secret"}'), undefined, channel)).toBe(false);
  });
});
