import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Configuração do onboarding pós-venda, lida do ambiente. Uma org, um canal
 * (Zappfy "Tiago 1258") e um agente — mesmo modelo do sales-recovery.
 */
@Injectable()
export class LeadOnboardingConfigService {
  constructor(private readonly config: ConfigService) {}

  /** Liga/desliga o fluxo inteiro (webhook continua aceitando, cron não envia). */
  get enabled(): boolean {
    return this.config.get<string>('ONBOARDING_ENABLED') === 'true';
  }

  get orgId(): string | null {
    return this.config.get<string>('ONBOARDING_ORG_ID') ?? null;
  }

  get channelId(): string | null {
    return this.config.get<string>('ONBOARDING_CHANNEL_ID') ?? null;
  }

  get agentId(): string | null {
    return this.config.get<string>('ONBOARDING_AGENT_ID') ?? null;
  }

  get webhookSecret(): string | null {
    return this.config.get<string>('HOPPE_WEBHOOK_SECRET') ?? null;
  }

  get calendarId(): string | null {
    return this.config.get<string>('ONBOARDING_CALENDAR_ID') ?? null;
  }

  /** E-mail do Pedro, convidado em todo diagnóstico. */
  get closerEmail(): string {
    return (
      this.config.get<string>('ONBOARDING_CLOSER_EMAIL') ?? 'produtos@asv.digital'
    );
  }

  /** Horas entre tentativas; a última é a espera antes de inativar. */
  get cadenceHours(): number[] {
    const parsed = (this.config.get<string>('ONBOARDING_FOLLOWUP_HOURS') ?? '')
      .split(',')
      .map((h) => Number(h.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length ? parsed : [4, 24, 24];
  }

  /** Janela de envio das tentativas (horas de Brasília, [start, end)). */
  get sendWindow(): { start: number; end: number } {
    const [start, end] = (this.config.get<string>('ONBOARDING_SEND_WINDOW') ?? '8-20')
      .split('-')
      .map((h) => Number(h));
    return {
      start: Number.isFinite(start) ? start : 8,
      end: Number.isFinite(end) ? end : 20,
    };
  }

  /** Máximo de 1ªs mensagens por dia (tentativas 2 e 3 não contam). */
  get dailyCap(): number {
    const n = Number(this.config.get<string>('ONBOARDING_DAILY_CAP'));
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  /** Cron do tick. Default: a cada 2 min. */
  get tickPattern(): string {
    return this.config.get<string>('ONBOARDING_TICK_CRON') ?? '*/2 * * * *';
  }
}
