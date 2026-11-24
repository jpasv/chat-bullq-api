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

describe('RecoveryConfigService.msUntilSendWindow', () => {
  const cfg = build({ RECOVERY_SEND_WINDOW: '8-21' });

  it('dentro do horário manda na hora (São Paulo, UTC-3)', () => {
    expect(cfg.msUntilSendWindow(new Date('2026-11-24T11:00:00Z'))).toBe(0); // 08:00
    expect(cfg.msUntilSendWindow(new Date('2026-11-24T23:59:59Z'))).toBe(0); // 20:59:59
  });

  it('depois das 21h espera até as 8h do dia seguinte', () => {
    expect(cfg.msUntilSendWindow(new Date('2026-11-25T00:00:00Z'))).toBe(11 * 3600 * 1000); // 21:00
    expect(cfg.msUntilSendWindow(new Date('2026-11-25T05:30:00Z'))).toBe(5.5 * 3600 * 1000); // 02:30
  });

  it('antes das 8h espera até as 8h', () => {
    expect(cfg.msUntilSendWindow(new Date('2026-11-24T10:00:00Z'))).toBe(3600 * 1000); // 07:00
  });

  it('sem janela configurada (ou inválida) manda a qualquer hora', () => {
    expect(build({}).msUntilSendWindow(new Date('2026-11-25T05:30:00Z'))).toBe(0);
    expect(build({ RECOVERY_SEND_WINDOW: '21-8' }).msUntilSendWindow(new Date('2026-11-25T05:30:00Z'))).toBe(0);
  });

  it('canais vigiados vêm do CSV', () => {
    expect(build({ RECOVERY_GUARD_CHANNEL_IDS: 'a, b' }).guardChannelIds).toEqual(['a', 'b']);
    expect(build({}).guardChannelIds).toEqual([]);
  });
});
