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

  /**
   * Canal pra abordar lead novo (API oficial desde 20/10). Sem ele, usa o
   * canal do onboarding (1258).
   */
  get outreachChannelId(): string | null {
    return this.config.get<string>('ONBOARDING_OUTREACH_CHANNEL_ID') ?? null;
  }

  /** Templates HSM aprovados na WABA do canal de abordagem. */
  get templates(): { abertura: string; lembrete: string; ultima: string; retomada: string; continuacao: string } {
    return {
      continuacao: this.config.get<string>('ONBOARDING_TEMPLATE_CONTINUACAO') ?? 'brvy_onb_continuacao',
      abertura: this.config.get<string>('ONBOARDING_TEMPLATE_ABERTURA') ?? 'brvy_onb_abertura',
      lembrete: this.config.get<string>('ONBOARDING_TEMPLATE_LEMBRETE') ?? 'brvy_onb_lembrete',
      ultima: this.config.get<string>('ONBOARDING_TEMPLATE_ULTIMA') ?? 'brvy_onb_ultima',
      retomada: this.config.get<string>('ONBOARDING_TEMPLATE_RETOMADA') ?? 'brvy_onb_retomada',
    };
  }

  get templateLang(): string {
    return this.config.get<string>('ONBOARDING_TEMPLATE_LANG') ?? 'pt_BR';
  }

  get agentId(): string | null {
    return this.config.get<string>('ONBOARDING_AGENT_ID') ?? null;
  }

  /** Agente de suporte que resolve acesso/uso do produto (default Lívia). */
  get supportAgentId(): string {
    return this.config.get<string>('ONBOARDING_SUPPORT_AGENT_ID') ?? 'agent_livia_001';
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

  /**
   * Agendas que também precisam estar livres e que entram no convite de todo
   * diagnóstico (pedido do Tiago, 19/10). Lista separada por vírgula.
   */
  get extraAttendees(): string[] {
    return (this.config.get<string>('ONBOARDING_EXTRA_ATTENDEES') ?? 'tiago@asv.digital')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
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

  /** Canal do chat do Hoppe avisado quando um lead precisa de humano. */
  get alertChannelId(): string | null {
    return (
      this.config.get<string>('ONBOARDING_HOPPE_CHANNEL_ID') ?? '106d566a-a896-4dc5-9ea2-3ef8ca970943'
    );
  }

  /** Cron do tick. Default: a cada 2 min. */
  get tickPattern(): string {
    return this.config.get<string>('ONBOARDING_TICK_CRON') ?? '*/2 * * * *';
  }
}
