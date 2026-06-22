import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Configuração da recuperação de vendas, lida do ambiente. Centraliza aqui
 * pra não espalhar `ConfigService.get(...)` pelos services e ter defaults
 * num lugar só.
 *
 * Na 1ª iteração assumimos UMA org/canal de outreach (envs abaixo). Pra
 * multi-org no futuro, trocar `resolveOrg/resolveChannel` por um mapa
 * productUuid → {orgId, channelId}.
 */
@Injectable()
export class RecoveryConfigService {
  private readonly logger = new Logger(RecoveryConfigService.name);

  constructor(private readonly config: ConfigService) {}

  /** Key do pipeline de recuperação (PipelineStage/Pipeline.key). */
  readonly pipelineKey = 'sales_recovery';

  get webhookSecret(): string | null {
    return this.config.get<string>('KIRVANO_WEBHOOK_SECRET') ?? null;
  }

  get orgId(): string | null {
    return this.config.get<string>('RECOVERY_ORG_ID') ?? null;
  }

  /** Canal Zappfy usado pra disparar o cold outreach. */
  get outreachChannelId(): string | null {
    return this.config.get<string>('RECOVERY_OUTREACH_CHANNEL_ID') ?? null;
  }

  /** Agentes de IA autorizados a mexer no pipeline de recuperação. */
  get agentIds(): string[] {
    return this.csv('RECOVERY_AGENT_IDS');
  }

  /** Agente dono das conversas de recuperação (primeiro da lista). */
  get recoveryAgentId(): string | null {
    return this.agentIds[0] ?? null;
  }

  /** UUIDs de produto rastreados (vazio = rastreia todos). */
  get trackedProductUuids(): string[] {
    return this.csv('RECOVERY_TRACKED_PRODUCT_UUIDS');
  }

  isProductTracked(productUuid: string | null): boolean {
    const tracked = this.trackedProductUuids;
    if (tracked.length === 0) return true; // sem allowlist = tudo
    return !!productUuid && tracked.includes(productUuid);
  }

  /** Cadência de follow-up em horas entre tentativas (ex: 24,48,72). */
  get followUpHours(): number[] {
    const raw = this.csv('RECOVERY_FOLLOWUP_HOURS');
    const parsed = raw.map((h) => Number(h)).filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length ? parsed : [24, 48, 72];
  }

  /** Máximo de tentativas de contato antes de marcar Perdido. */
  get maxAttempts(): number {
    const n = Number(this.config.get<string>('RECOVERY_MAX_ATTEMPTS'));
    return Number.isFinite(n) && n > 0 ? n : 3;
  }

  /**
   * Template da 1ª mensagem proativa. Placeholders: {nome} {produto} {link}.
   * Mantido curto de propósito (deliverability via Zappfy não-oficial).
   */
  get openerTemplate(): string {
    return (
      this.config.get<string>('RECOVERY_OPENER_TEMPLATE') ??
      'Oi {nome}! Vi que você se interessou por {produto} mas não finalizou. Posso te ajudar a concluir? Se quiser, é só por aqui: {link}'
    );
  }

  /** Texto do follow-up automático (lembrete). Placeholders: {nome} {produto} {link}. */
  get followUpTemplate(): string {
    return (
      this.config.get<string>('RECOVERY_FOLLOWUP_TEMPLATE') ??
      'Oi {nome}, passando pra saber se ainda tem interesse em {produto}. Qualquer dúvida me chama! {link}'
    );
  }

  /** Cron do watchdog de cards parados. Default: a cada 30min. */
  get watchdogPattern(): string {
    return (
      this.config.get<string>('RECOVERY_WATCHDOG_CRON') ?? '*/30 * * * *'
    );
  }

  private csv(key: string): string[] {
    return (this.config.get<string>(key) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
