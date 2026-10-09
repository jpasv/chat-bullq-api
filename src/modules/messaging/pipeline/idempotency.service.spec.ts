import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService claims', () => {
  const service = Object.create(IdempotencyService.prototype) as IdempotencyService;
  const redis = { set: jest.fn(), eval: jest.fn() };
  beforeEach(() => { jest.clearAllMocks(); (service as any).redis = redis; });

  it('stores a unique ownership token and returns null on contention', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const token = await service.claimProcessing('external', 'channel');
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(redis.set).toHaveBeenCalledWith('idemp:channel:external', token, 'EX', 86400, 'NX');
    expect(await service.claimProcessing('external', 'channel')).toBeNull();
  });

  it('releases via atomic compare-and-delete with the original token', async () => {
    await service.releaseClaim('external', 'channel', 'old-owner');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      1, 'idemp:channel:external', 'old-owner',
    );
  });

  it('keeps messages without external IDs processable without Redis', async () => {
    const token = await service.claimProcessing('', 'channel');
    expect(token).toBeTruthy();
    await service.releaseClaim('', 'channel', token!);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
