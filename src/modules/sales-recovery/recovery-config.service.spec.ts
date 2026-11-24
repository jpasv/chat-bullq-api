import { ConfigService } from '@nestjs/config';
import { RecoveryConfigService } from './recovery-config.service';

function build(env: Record<string, string>): RecoveryConfigService {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new RecoveryConfigService(config);
}

describe('RecoveryConfigService', () => {
  it('IA ligada por padrão; RECOVERY_AI_ENABLED=false desliga', () => {
    expect(build({}).aiEnabled).toBe(true);
    expect(build({ RECOVERY_AI_ENABLED: 'false' }).aiEnabled).toBe(false);
    expect(build({ RECOVERY_AI_ENABLED: ' FALSE ' }).aiEnabled).toBe(false);
    expect(build({ RECOVERY_AI_ENABLED: 'true' }).aiEnabled).toBe(true);
  });

  it('sem RECOVERY_ACTIVE_SINCE todo card está na janela', () => {
    expect(build({}).isInActiveWindow(new Date('2020-01-01'))).toBe(true);
    expect(build({ RECOVERY_ACTIVE_SINCE: 'lixo' }).isInActiveWindow(new Date('2020-01-01'))).toBe(true);
  });

  it('com RECOVERY_ACTIVE_SINCE só cards criados depois recebem mensagem', () => {
    const cfg = build({ RECOVERY_ACTIVE_SINCE: '2026-11-24T18:00:00Z' });
    expect(cfg.isInActiveWindow(new Date('2026-11-24T17:59:59Z'))).toBe(false);
    expect(cfg.isInActiveWindow(new Date('2026-11-24T18:00:00Z'))).toBe(true);
    expect(cfg.isInActiveWindow(new Date('2026-11-25T09:00:00Z'))).toBe(true);
  });
});
