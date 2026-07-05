import { ApiKeyThrottleGuard } from './api-key-throttle.guard';
import { ExecutionContext } from '@nestjs/common';

function ctx(key: string): ExecutionContext {
  const req = { headers: { authorization: `Bearer ${key}` } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('ApiKeyThrottleGuard', () => {
  it('permite requisições abaixo do limite', () => {
    const guard = new ApiKeyThrottleGuard();
    for (let i = 0; i < 100; i++) expect(guard.canActivate(ctx('k1'))).toBe(true);
  });

  it('bloqueia (429) ao exceder o limite na mesma janela', () => {
    const guard = new ApiKeyThrottleGuard();
    for (let i = 0; i < 100; i++) guard.canActivate(ctx('k2'));
    expect(() => guard.canActivate(ctx('k2'))).toThrow(/Too Many Requests|429|rate/i);
  });

  it('isola contadores por key', () => {
    const guard = new ApiKeyThrottleGuard();
    for (let i = 0; i < 100; i++) guard.canActivate(ctx('kA'));
    expect(guard.canActivate(ctx('kB'))).toBe(true);
  });
});
